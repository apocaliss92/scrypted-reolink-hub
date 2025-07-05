import sdk, { MediaObject, Setting, Settings, VideoClip, VideoClipOptions, VideoClips, VideoClipThumbnailOptions } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import fs from 'fs';
import path from 'path';
import url from 'url';
import { calculateSize, cleanupMemoryThresholderInGb } from '../../scrypted-events-recorder/src/util';
import { VideoSearchResult, VideoSearchTime, VideoSearchType } from "../../scrypted-reolink-videoclips/src/client";
import { getFolderPaths, parseVideoclipName, splitDateRangeByDay } from "../../scrypted-reolink-videoclips/src/utils";
import { ReolinkCamera } from "./camera";
import { pluginId } from "./main";
import ReolinkVideoclips from "./videoclips";
import { getBaseLogger, logLevelSetting } from "../../scrypted-apocaliss-base/src/basePlugin";

const { endpointManager } = sdk;

interface VideoclipFileData {
    filename: string;
    fullPath: string;
    time: VideoSearchTime;
    type: 'video' | 'image';
    size: number;
}

const videoclippathRegex = new RegExp('(.*)([0-9]{4})([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{2})(.*)');

export default class ReolinkVideoclipssMixin extends SettingsMixinDeviceBase<any> implements Settings, VideoClips {
    killed: boolean;
    ftpScanTimeout: NodeJS.Timeout;
    ftpScanData: VideoclipFileData[] = [];
    logger: Console;
    lastScanFs: number;
    camera: ReolinkCamera;
    thumbnailsToGenerate: string[] = [];
    thumbnailsGeneratorInterval: NodeJS.Timeout;
    generatingThumbnails = false;

    storageSettings = new StorageSettings(this, {
        logLevel: {
            ...logLevelSetting,
        },
        ftp: {
            title: 'Fetch from FTP folder',
            type: 'boolean',
            immediate: true,
            onPut: async () => this.checkFtpScan()
        },
        ftpFolder: {
            title: 'FTP folder',
            description: 'FTP folder where reolink stores the clips',
            type: 'string',
            onPut: async () => this.checkFtpScan()
        },
        filenamePrefix: {
            title: 'Filename content (leave empty to let plugin find the clips)',
            description: 'This should contain any relevant text to identify the camera clips. I.e. Videocamera dispensa_00_20250105123640.mp4 -> Videocamera dispensa_00_',
            type: 'string',
            onPut: async () => this.checkFtpScan()
        },
        maxSpaceInGb: {
            title: 'Dedicated memory in GB',
            type: 'number',
            defaultValue: 20,
            onPut: async (_, newValue) => await this.scanFs(newValue)
        },
        occupiedSpaceInGb: {
            title: 'Memory occupancy in GB',
            type: 'number',
            range: [0, 20],
            readonly: true,
            placeholder: 'GB'
        },
    });

    constructor(options: SettingsMixinDeviceOptions<any>, private plugin: ReolinkVideoclips) {
        super(options);

        const logger = this.getLogger();

        this.plugin.currentMixinsMap[this.id] = this;

        this.camera = this.plugin.plugin.devices.get(this.nativeId);
        this.checkFtpScan().catch(logger.log);

        this.thumbnailsGeneratorInterval && clearInterval(this.thumbnailsGeneratorInterval);
        this.thumbnailsGeneratorInterval = setInterval(async () => {
            if (!this.generatingThumbnails) {
                this.generatingThumbnails = true;

                if (this.thumbnailsToGenerate.length) {
                    for (const thumbnailId of this.thumbnailsToGenerate) {
                        const { filename: filenameSrc, videoclipUrl, thumbnailFolder } = await this.getVideoclipParams(thumbnailId);

                        try {
                            const filename = filenameSrc.replaceAll(' ', '_');
                            const outputThumbnailFile = path.join(thumbnailFolder, `${filename}.jpg`);

                            const mo = await sdk.mediaManager.createFFmpegMediaObject({
                                inputArguments: [
                                    '-ss', '00:00:05',
                                    '-i', videoclipUrl,
                                ],
                            });
                            const jpeg = await sdk.mediaManager.convertMediaObjectToBuffer(mo, 'image/jpeg');
                            if (jpeg.length) {
                                logger.log(`Saving thumbnail in ${outputThumbnailFile}`);
                                await fs.promises.writeFile(outputThumbnailFile, jpeg);
                            } else {
                                logger.log('Not saving, image is corrupted');
                            }
                        } catch (e) {
                            logger.log('Failed generating thumbnail', videoclipUrl, thumbnailId, e);
                        }
                    }
                    this.thumbnailsToGenerate = [];
                }

                this.generatingThumbnails = false;
            }
        }, 10000);
    }

    public getLogger() {
        return getBaseLogger({
            console: this.console,
            storage: this.storageSettings,
        });
    }

    async release() {
        this.killed = true;
        this.thumbnailsGeneratorInterval && clearInterval(this.thumbnailsGeneratorInterval);
    }

    async checkFtpScan() {
        const { ftp, ftpFolder } = this.storageSettings.values;
        if (ftp && ftpFolder) {
            await this.startFtpScan();
        } else {
            this.stopFtpScan();
        }
    }

    stopFtpScan() {
        if (this.ftpScanTimeout) {
            clearInterval(this.ftpScanTimeout);
        }

        this.ftpScanTimeout = undefined;
    }

    get fileNamePrefix() {
        const { filenamePrefix } = this.storageSettings.values;

        if (filenamePrefix) {
            return filenamePrefix;
        }

        let channel = String(this.camera.getRtspChannel());
        if (channel.length === 1) {
            channel = `0${channel}`;
        }

        return `_${channel}_`;
    }

    async startFtpScan() {
        const logger = this.getLogger();
        const { ftpFolder } = this.storageSettings.values;
        this.stopFtpScan();
        const filenamePrefix = this.fileNamePrefix;

        const searchFile = async (dir: string, currentResult: VideoclipFileData[] = []) => {
            const result: VideoclipFileData[] = [...currentResult];
            const files = await fs.promises.readdir(dir) || [];

            const filteredFiles = files.filter(file =>
                (filenamePrefix ? file.includes(filenamePrefix) : true) &&
                file.endsWith('mp4')
            );
            logger.debug(`Files found: ${JSON.stringify({ files, filteredFiles })}`);

            for (const file of filteredFiles) {
                const fullPath = path.join(dir, file);

                const fileStat = fs.statSync(fullPath);

                if (fileStat.isDirectory()) {
                    result.push(...(await searchFile(fullPath, result)));
                } else {
                    let timestamp = file;

                    if (filenamePrefix) {
                        const splitted = file.split(filenamePrefix);
                        timestamp = splitted[1];
                    }
                    logger.debug(`Parsing filename: ${JSON.stringify({
                        file,
                        timestamp,
                        videoclippathRegex
                    })}`);

                    try {
                        const regexResult = videoclippathRegex.exec(timestamp);
                        if (regexResult) {
                            const [__, ___, year, mon, day, hour, min, sec] = regexResult;

                            result.push({
                                filename: file,
                                fullPath,
                                time: {
                                    day: Number(day),
                                    hour: Number(hour),
                                    min: Number(min),
                                    mon: Number(mon),
                                    sec: Number(sec),
                                    year: Number(year),
                                },
                                type: file.endsWith('mp4') ? 'video' : 'image',
                                size: fileStat.size
                            });
                        }
                    } catch (e) {
                        logger.log(`Error parsing file ${file} in path ${dir}`);
                    }
                }
            }

            return result;
        }

        this.ftpScanTimeout && clearInterval(this.ftpScanTimeout);
        this.ftpScanTimeout = setInterval(async () => {
            try {
                const now = Date.now();

                this.ftpScanData = await searchFile(ftpFolder);

                // Every 1 hour
                if (!this.lastScanFs || (now - this.lastScanFs) > (1000 * 60 * 60)) {
                    await this.scanFs();
                }
            }
            catch (e) {
                logger.log('Error in scanning the ftp folder', e);
            }
        }, 1000 * 10);

        await this.scanFs();
        this.ftpScanData = await searchFile(ftpFolder);
    }

    async scanFs(newMaxMemory?: number) {
        const logger = this.getLogger();
        if (!this.storageSettings.values.ftp) {
            return;
        }

        logger.log(`Starting FS scan: ${JSON.stringify({ newMaxMemory })}`);

        const { ftpFolder } = this.storageSettings.values;
        const { maxSpaceInGb: maxSpaceInGbSrc } = this.storageSettings.values;
        const maxSpaceInGb = newMaxMemory ?? maxSpaceInGbSrc;
        const filenamePrefix = this.fileNamePrefix;

        const { occupiedSpaceInGb, occupiedSpaceInGbNumber, freeMemory } = await calculateSize({
            currentPath: ftpFolder,
            filenamePrefix,
            maxSpaceInGb
        });
        this.storageSettings.settings.occupiedSpaceInGb.range = [0, maxSpaceInGb]
        this.putMixinSetting('occupiedSpaceInGb', occupiedSpaceInGb);
        logger.debug(`Occupied space: ${occupiedSpaceInGb} GB`);

        // if (freeMemory <= cleanupMemoryThresholderInGb) {
        //     const files = await fs.promises.readdir(ftpFolder);

        //     const fileDetails = files
        //         .map((file) => {
        //             const match = filenamePrefix ? file.startsWith(filenamePrefix) : true;
        //             if (match) {
        //                 let timestamp = file;

        //                 if (filenamePrefix) {
        //                     const splitted = file.split(filenamePrefix);
        //                     timestamp = splitted[1];
        //                 }

        //                 const regexResult = videoclippathRegex.exec(timestamp);
        //                 if (regexResult) {
        //                     const [__, ___, year, mon, day, hour, min, sec] = regexResult;
        //                     const time: VideoSearchTime = {
        //                         day: Number(day),
        //                         hour: Number(hour),
        //                         min: Number(min),
        //                         mon: Number(mon),
        //                         sec: Number(sec),
        //                         year: Number(year),
        //                     }
        //                     const timestampParsed = this.processDate(time);

        //                     const { videoClipPath } = this.getStorageDirs(file);
        //                     return { file, fullPath: videoClipPath, timeStart: Number(timeStart) };
        //                 }
        //             }
        //             return null;
        //         })
        //         .filter(Boolean);

        //     fileDetails.sort((a, b) => a.timeStart - b.timeStart);

        //     const filesToDelete = Math.min(fileDetails.length, clipsToCleanup);

        //     logger.log(`Deleting ${filesToDelete} oldest files... ${JSON.stringify({ freeMemory, cleanupMemoryThresholderInGb })}`);

        //     for (let i = 0; i < filesToDelete; i++) {
        //         const { fullPath, file } = fileDetails[i];
        //         await fs.promises.rm(fullPath, { force: true, recursive: true, maxRetries: 10 });
        //         logger.log(`Deleted videoclip: ${file}`);
        //         const { thumbnailPath } = this.getStorageDirs(file);
        //         await fs.promises.rm(thumbnailPath, { force: true, recursive: true, maxRetries: 10 });
        //         logger.log(`Deleted thumbnail: ${thumbnailPath}`);
        //     }
        // }

        this.lastScanFs = Date.now();
        logger.log(`FS scan executed: ${JSON.stringify({
            freeMemory,
            occupiedSpaceInGbNumber,
            maxSpaceInGb,
            cleanupMemoryThresholderInGb
        })}`);
    }

    async getClient() {
        return this.camera.getClient();
    }

    async getVideoclipWebhookUrls(videoclipPath: string) {
        const cloudEndpoint = await endpointManager.getCloudEndpoint(undefined, { public: true });
        const [endpoint, parameters] = cloudEndpoint.split('?') ?? '';
        const params = {
            nativeId: this.nativeId,
            deviceId: this.id,
            videoclipPath,
        };

        const videoclipUrl = `${endpoint}videoclip?params=${JSON.stringify(params)}&${parameters}`;
        const thumbnailUrl = `${endpoint}thumbnail?params=${JSON.stringify(params)}&${parameters}`;

        return { videoclipUrl, thumbnailUrl };
    }

    private processDate(date: VideoSearchTime) {
        let timeDate = new Date();

        timeDate.setFullYear(date.year);
        timeDate.setMonth(date.mon - 1);
        timeDate.setDate(date.day);
        timeDate.setHours(date.hour);
        timeDate.setMinutes(date.min);
        timeDate.setSeconds(date.sec);

        return timeDate.getTime();
    }

    async getVideoClips(options?: VideoClipOptions, streamType: VideoSearchType = 'main') {
        const logger = this.getLogger();
        try {
            const { ftp } = this.storageSettings.values;

            const videoclips: VideoClip[] = [];

            if (ftp) {
                for (const item of this.ftpScanData) {
                    const timestamp = this.processDate(item.time);

                    if (item.type === 'video' && timestamp >= options.startTime && timestamp <= options.endTime) {
                        // Check if possible to fetch it with decent performances
                        const durationInMs = 30;
                        const videoclipPath = item.fullPath;

                        const event = 'motion';
                        const { thumbnailUrl, videoclipUrl } = await this.getVideoclipWebhookUrls(videoclipPath);
                        videoclips.push({
                            id: videoclipPath,
                            startTime: timestamp,
                            // duration: Math.round(durationInMs),
                            videoId: videoclipPath,
                            thumbnailId: videoclipPath,
                            detectionClasses: [event],
                            event,
                            description: event,
                            resources: {
                                thumbnail: {
                                    href: thumbnailUrl
                                },
                                video: {
                                    href: videoclipUrl
                                }
                            }
                        });
                    }
                }
                logger.info(`Videoclips found:`, JSON.stringify({ videoclips }));
            } else {
                const api = await this.getClient();

                const dateRanges = splitDateRangeByDay(options.startTime, options.endTime);

                let allSearchedElements: VideoSearchResult[] = [];

                for (const dateRange of dateRanges) {
                    const response = await api.getVideoClips(
                        this.camera.getRtspChannel(),
                        { startTime: dateRange.start, endTime: dateRange.end }
                    );
                    allSearchedElements.push(...response);
                }

                logger.info(`Videoclips found:`, JSON.stringify({
                    allSearchedElements,
                    dateRanges,
                    token: api.parameters.token
                }));

                for (const searchElement of allSearchedElements) {
                    const videoclipPath = searchElement.name;
                    try {
                        const startTime = this.processDate(searchElement.StartTime);
                        const entdTime = this.processDate(searchElement.EndTime);

                        const durationInMs = entdTime - startTime;
                        const { detectionClasses } = parseVideoclipName(videoclipPath, this.console) ?? {};

                        const event = 'motion';
                        const { thumbnailUrl, videoclipUrl } = await this.getVideoclipWebhookUrls(videoclipPath);
                        videoclips.push({
                            id: videoclipPath,
                            startTime,
                            duration: Math.round(durationInMs),
                            videoId: videoclipPath,
                            thumbnailId: videoclipPath,
                            detectionClasses: detectionClasses ?? [event],
                            event,
                            description: pluginId,
                            resources: {
                                thumbnail: {
                                    href: thumbnailUrl
                                },
                                video: {
                                    href: videoclipUrl
                                }
                            }
                        });
                    } catch (e) {
                        logger.log(`error parsing videoclip ${videoclipPath}: ${JSON.stringify(searchElement)}`, e);
                    }
                }
            }

            return videoclips;
        } catch (e) {
            logger.log('Error during get videoClips', e);
        }
    }

    async getVideoclipParams(videoclipId: string) {
        const { ftp } = this.storageSettings.values;
        const { thumbnailFolder } = getFolderPaths(this.id, this.camera.plugin.storageSettings.values.downloadFolder);
        const filename = `${videoclipId.split('/').pop().split('.')[0]}`;

        let videoclipUrl: string;
        if (ftp) {
            videoclipUrl = videoclipId;
        } else {
            const api = await this.getClient();
            const { downloadPathWithHost } = await api.getVideoClipUrl(
                videoclipId,
                this.camera.getRtspChannel(),
            );
            videoclipUrl = downloadPathWithHost;
        }

        return { videoclipUrl, filename, thumbnailFolder };
    }

    async getVideoClip(videoId: string): Promise<MediaObject> {
        const logger = this.getLogger();
        logger.log('Fetching videoId ', videoId);
        const { videoclipUrl } = await this.getVideoclipWebhookUrls(videoId);
        const videoclipMo = await sdk.mediaManager.createMediaObject(videoclipUrl, 'video/mp4');

        return videoclipMo;
    }

    async getVideoClipThumbnail(thumbnailId: string, options?: VideoClipThumbnailOptions): Promise<MediaObject> {
        const logger = this.getLogger();
        logger.info('Fetching thumbnailId ', thumbnailId);
        const { filename: filenameSrc, videoclipUrl, thumbnailFolder } = await this.getVideoclipParams(thumbnailId);
        const filename = filenameSrc.replaceAll(' ', '_');
        const outputThumbnailFile = path.join(thumbnailFolder, `${filename}.jpg`);
        let thumbnailMo: MediaObject;

        try {
            if (fs.existsSync(outputThumbnailFile) && fs.statSync(outputThumbnailFile).size === 0) {
                logger.log(`Thumbnail ${outputThumbnailFile} corrupted, removing.`);
                fs.rmSync(outputThumbnailFile);
            }

            if (!fs.existsSync(outputThumbnailFile)) {
                let shouldGenerate = false;

                if (this.storageSettings.values.ftp) {
                    try {
                        const parts = thumbnailId.split('.')[0].split('_');
                        const timestamp = Number(parts[parts.length - 1]);

                        const dir = path.dirname(thumbnailId);

                        const jpgNearby = fs.readdirSync(dir)
                            .filter(file => file.endsWith('.jpg'))
                            .find(file => {
                                const m = file.endsWith('.jpg');
                                if (!m) return false;
                                const partsInner = file.split('.')[0].split('_');
                                const timestampInner = Number(partsInner[partsInner.length - 1]);

                                const diff = Math.abs(timestampInner - timestamp);
                                return diff <= 2 * 1000;
                            });

                        if (jpgNearby) {
                            const jpegPath = path.join(this.storageSettings.values.ftpFolder, jpgNearby);
                            const filename = filenameSrc.replaceAll(' ', '_');
                            const outputThumbnailFile = path.join(thumbnailFolder, `${filename}.jpg`);
                            const jpeg = await fs.promises.readFile(jpegPath)
                            if (jpeg.length) {
                                logger.log(`Copying thumbnail in ${outputThumbnailFile}`);
                                await fs.promises.writeFile(outputThumbnailFile, jpeg);
                            } else {
                                logger.log('Not saving, image is corrupted');
                                shouldGenerate = true;
                            }
                        } else {
                            shouldGenerate = true;
                        }
                    } catch {
                        shouldGenerate = true;
                    }
                }

                if (shouldGenerate) {
                    logger.log(`Thumbnail not found in ${outputThumbnailFile}, generating.`);
                    this.thumbnailsToGenerate.push(thumbnailId);
                }
            } else {
                const fileURLToPath = url.pathToFileURL(outputThumbnailFile).toString();
                thumbnailMo = await sdk.mediaManager.createMediaObjectFromUrl(fileURLToPath);
            }

            return thumbnailMo;
        } catch (e) {
            logger.error(`Error retrieving thumbnail of videoclip ${filename} (${videoclipUrl})`, e);
            fs.existsSync(outputThumbnailFile) && fs.rmSync(outputThumbnailFile);

            return null;
        }
    }

    removeVideoClips(...videoClipIds: string[]): Promise<void> {
        throw new Error("Method not implemented.");
    }

    async getMixinSettings(): Promise<Setting[]> {
        const isFtp = this.storageSettings.values.ftp;
        this.storageSettings.settings.filenamePrefix.hide = !isFtp;
        this.storageSettings.settings.ftpFolder.hide = !isFtp;
        this.storageSettings.settings.maxSpaceInGb.hide = !isFtp;
        this.storageSettings.settings.occupiedSpaceInGb.hide = !isFtp;

        const settings = await this.storageSettings.getSettings();

        return settings;
    }

    async putMixinSetting(key: string, value: string) {
        this.storage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
}
