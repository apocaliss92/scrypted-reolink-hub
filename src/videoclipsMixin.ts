import { sleep } from "@scrypted/common/src/sleep";
import sdk, { MediaObject, Setting, Settings, VideoClip, VideoClipOptions, VideoClips, VideoClipThumbnailOptions } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import url from 'url';
import { getBaseLogger } from "../../scrypted-apocaliss-base/src/basePlugin";
import { calculateSize } from '../../scrypted-events-recorder/src/util';
import { VideoSearchResult, VideoSearchTime, VideoSearchType } from "../../scrypted-reolink-videoclips/src/client";
import { getFolderPaths, parseVideoclipName, splitDateRangeByDay } from "../../scrypted-reolink-videoclips/src/utils";
import { ReolinkCamera } from "./camera";
import { pluginId } from "./main";
import ReolinkVideoclips from "./videoclips";

const { endpointManager } = sdk;

interface VideoclipSrcFtpData {
    filename: string;
    fullPath: string;
    size: number;
    timestamp: number;
}

const videoclippathRegex = new RegExp('(.*)([0-9]{4})([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{2})(.*)');

export default class ReolinkVideoclipssMixin extends SettingsMixinDeviceBase<any> implements Settings, VideoClips {
    killed: boolean;
    ftpScanTimeout: NodeJS.Timeout;
    parseVideoclipsTimeout: NodeJS.Timeout;
    logger: Console;
    camera: ReolinkCamera;
    parsingVideoclips = false;
    videoErrorCount: Map<string, number> = new Map();
    ffmpegGenerationTimeout: Map<string, NodeJS.Timeout> = new Map();
    blacklistedVideos: Set<string> = new Set();

    storageSettings = new StorageSettings(this, {
        ftp: {
            title: 'Fetch from FTP folder',
            type: 'boolean',
            immediate: true,
            defaultValue: true,
        },
        ftpFolder: {
            title: 'FTP folder',
            description: 'FTP folder where reolink stores the clips',
            type: 'string',
        },
        filenamePrefix: {
            title: 'Filename content (leave empty to let plugin find the clips)',
            description: 'This should contain any relevant text to identify the camera clips. I.e. Videocamera dispensa_00_20250105123640.mp4 -> Videocamera dispensa_00_',
            type: 'string',
        },
        maxSpaceInGb: {
            title: 'Dedicated memory in GB',
            type: 'number',
            defaultValue: 20,
            onPut: async (_, newValue) => await this.scanMemoryUsage(newValue)
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

        this.plugin.currentMixinsMap[this.id] = this;

        this.camera = this.plugin.plugin.devices.get(this.nativeId);
        setTimeout(() => this.checkFtpScan().catch(this.getLogger()?.log), 3000);
    }

    public getLogger() {
        // return this.camera?.getLogger();
        return getBaseLogger({
            console: this.console,
            storage: this.camera.storageSettings,
        });
    }

    async release() {
        this.killed = true;
        this.stopVideoclipsParser();
        this.stopFtpScan();
    }

    async checkFtpScan() {
        if (!this.killed) {
            const { ftp, ftpFolder } = this.storageSettings.values;
            const logger = this.getLogger();
            if (ftp && ftpFolder) {
                !this.ftpScanTimeout && logger.log(`FTP folder scan interval started`);
                await this.startFtpScan();

                !this.parseVideoclipsTimeout && logger.log(`FTP videoclips parser started`);
                await this.startVideoclipsParser();
            } else {
                this.ftpScanTimeout && logger.log(`FTP folder scan interval stopped`);
                this.stopFtpScan();

                this.parseVideoclipsTimeout && logger.log(`FTP videoclips parser stopped`);
                await this.stopVideoclipsParser();
            }
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

    /**
     * Tracks video processing errors and blacklists videos that fail more than 2 times
     * @param videoPath The path of the video that failed
     * @returns true if the video should be blacklisted, false otherwise
     */
    private handleVideoError(videoPath: string): boolean {
        const currentCount = this.videoErrorCount.get(videoPath) || 0;
        const newCount = currentCount + 1;

        this.videoErrorCount.set(videoPath, newCount);

        if (newCount > 2) {
            this.blacklistedVideos.add(videoPath);
            this.getLogger().warn(`Video ${videoPath} blacklisted after ${newCount} failed attempts`);
            return true;
        }

        this.getLogger().debug(`Video ${videoPath} error count: ${newCount}/3`);
        return false;
    }

    async startVideoclipsParser() {
        this.stopVideoclipsParser();
        const logger = this.getLogger();
        const parsedFolder = this.getFtpParsedDirectory();
        await fs.promises.mkdir(parsedFolder, { recursive: true });

        this.parseVideoclipsTimeout = setInterval(async () => {
            if (!this.parsingVideoclips) {
                try {
                    const { ftpFolder } = this.storageSettings.values;
                    const foundVideos = await this.searchSourceFptFiles(ftpFolder);

                    if (foundVideos.length) {
                        const videosToProcess = foundVideos.filter(video => !this.blacklistedVideos.has(video.fullPath));
                        const blacklistedCount = foundVideos.length - videosToProcess.length;

                        if (blacklistedCount > 0) {
                            logger.log(`${blacklistedCount} videos are blacklisted and will be skipped`);
                        }

                        if (videosToProcess.length === 0) {
                            logger.log(`No videos to process (${foundVideos.length} total, ${blacklistedCount} blacklisted)`);
                            return;
                        }

                        logger.log(`${videosToProcess.length} videoclips will be parsed (${blacklistedCount} blacklisted)`);

                        for (let i = 0; i < videosToProcess.length; i++) {
                            const video = videosToProcess[i];
                            const { fullPath, filename } = video;
                            const remainingCount = videosToProcess.length - i - 1;

                            try {
                                this.parsingVideoclips = true;
                                const duration = await this.getVideoDurationWithFFmpeg(fullPath);
                                if (duration) {
                                    logger.log(`Duration found for video ${fullPath}: ${duration}`);
                                    let foundThumbnailBuffer = await this.findFtpThumbnail(fullPath);

                                    if (!foundThumbnailBuffer) {
                                        logger.log(`Thumbnail not found for video ${filename}, generating`);
                                        foundThumbnailBuffer = await this.generateThumbnail(fullPath);
                                        logger.log(`Thumbnail for video ${filename} generated`);
                                    }

                                    if (foundThumbnailBuffer) {
                                        const parts = fullPath.split('.')[0].split('_');
                                        const timestampString = parts[parts.length - 1];

                                        const timestampMillis = this.convertTimestampToMillis(timestampString);

                                        const newVideoName = `${timestampMillis}_${Math.round(duration)}.mp4`;
                                        const newThumbnailName = `${timestampMillis}.jpeg`;

                                        const newVideoPath = path.join(parsedFolder, newVideoName);
                                        const newThumbnailPath = path.join(parsedFolder, newThumbnailName);

                                        await fs.promises.copyFile(fullPath, newVideoPath);
                                        await fs.promises.rm(fullPath, { force: true, maxRetries: 10 });

                                        await fs.promises.writeFile(newThumbnailPath, foundThumbnailBuffer);

                                        logger.log(`Successfully processed video: ${filename} -> ${newVideoName} (${duration}s)`);
                                        logger.log(`Successfully processed thumbnail: ${foundThumbnailBuffer.length} bytes -> ${newThumbnailName}`);

                                        this.videoErrorCount.delete(fullPath)
                                    } else {
                                        logger.warn(`No thumbnail found for video: ${filename}`);
                                        // Handle error for missing thumbnail
                                        const shouldBlacklist = this.handleVideoError(fullPath);
                                        if (shouldBlacklist) {
                                            logger.warn(`Video ${filename} will be skipped in future processing`);
                                        }
                                    }
                                } else {
                                    logger.warn(`Could not extract duration for video: ${filename}`);
                                    // Handle error for duration extraction failure
                                    const shouldBlacklist = this.handleVideoError(fullPath);
                                    if (shouldBlacklist) {
                                        logger.warn(`Video ${filename} will be skipped in future processing`);
                                    }
                                }
                            } catch (e) {
                                logger.error(`Error during parsing video ${fullPath}:`, e);
                                // Handle general processing error
                                const shouldBlacklist = this.handleVideoError(fullPath);
                                if (shouldBlacklist) {
                                    logger.warn(`Video ${filename} will be skipped in future processing`);
                                }
                            } finally {
                                logger.log(`Remaining videoclips to process: ${remainingCount}`);

                                await sleep(2000);
                            }
                        }
                    }
                } catch (e) {
                    logger.log('Error in scanning the ftp folder', e);
                } finally {
                    this.parsingVideoclips = false;
                }
            }
        }, 1000 * 10);
    }

    async stopVideoclipsParser() {
        if (this.parseVideoclipsTimeout) {
            clearInterval(this.parseVideoclipsTimeout);
        }

        this.parseVideoclipsTimeout = undefined;
    }

    async searchSourceFptFiles(dir: string, currentResult: VideoclipSrcFtpData[] = []) {
        const filenamePrefix = this.fileNamePrefix;
        const logger = this.getLogger();

        const result: VideoclipSrcFtpData[] = [...currentResult];
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
                result.push(...(await this.searchSourceFptFiles(fullPath, result)));
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
                    const parts = fullPath.split('.')[0].split('_');
                    const timestampString = parts[parts.length - 1];

                    const timestamp = this.convertTimestampToMillis(timestampString);

                    result.push({
                        filename: file,
                        fullPath,
                        timestamp,
                        size: fileStat.size
                    });
                } catch (e) {
                    logger.log(`Error parsing file ${file} in path ${dir}`);
                }
            }
        }

        return result;
    }

    async startFtpScan() {
        const logger = this.getLogger();

        this.stopFtpScan();
        this.ftpScanTimeout = setInterval(async () => {
            try {
                if (this.storageSettings.values.ftp) {
                    await this.scanMemoryUsage();
                }
            }
            catch (e) {
                logger.log('Error in scanning the ftp folder', e);
            }
        }, 1000 * 60 * 60);

        await this.scanMemoryUsage();
    }

    async scanMemoryUsage(newMaxMemory?: number) {
        const logger = this.getLogger();

        logger.log(`FS memory scan initialized`);

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


        const cleanupMemoryThresholderInGb = maxSpaceInGb * 0.05;
        if (freeMemory <= cleanupMemoryThresholderInGb) {
            const parsedFolder = this.getFtpParsedDirectory();
            const files = await fs.promises.readdir(parsedFolder);

            const fileDetails = files
                .map((file) => {
                    if (file.endsWith('.mp4')) {
                        try {
                            const [timestampString] = file.split('.')[0].split('_');
                            const timestamp = Number(timestampString);
                            const videoClipPath = path.join(parsedFolder, file);
                            const thumbnailPath = path.join(parsedFolder, `${timestampString}.jpeg`);

                            return {
                                file,
                                fullPath: videoClipPath,
                                thumbnailPath,
                                timeStart: timestamp
                            };
                        } catch (e) {
                            logger.warn(`Error parsing file ${file} for cleanup`);
                            return null;
                        }
                    }
                    return null;
                })
                .filter(Boolean);

            fileDetails.sort((a, b) => a.timeStart - b.timeStart);

            const clipsToCleanup = Math.floor(fileDetails.length * 0.1);
            const filesToDelete = Math.min(fileDetails.length, clipsToCleanup);

            logger.log(`Deleting ${filesToDelete} oldest files... ${JSON.stringify({ freeMemory, cleanupMemoryThresholderInGb })}`);

            for (let i = 0; i < filesToDelete; i++) {
                const { fullPath, file, thumbnailPath } = fileDetails[i];
                try {
                    await fs.promises.rm(fullPath, { force: true, maxRetries: 10 });
                    logger.log(`Deleted videoclip: ${file}`);

                    if (fs.existsSync(thumbnailPath)) {
                        await fs.promises.rm(thumbnailPath, { force: true, maxRetries: 10 });
                        logger.log(`Deleted thumbnail: ${path.basename(thumbnailPath)}`);
                    }
                } catch (e) {
                    logger.error(`Error deleting files: ${file}`, e);
                }
            }
        }

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

    private convertTimestampToMillis(timestampString: string): number {
        const year = parseInt(timestampString.substring(0, 4), 10);
        const month = parseInt(timestampString.substring(4, 6), 10);
        const day = parseInt(timestampString.substring(6, 8), 10);
        const hour = parseInt(timestampString.substring(8, 10), 10);
        const min = parseInt(timestampString.substring(10, 12), 10);
        const sec = parseInt(timestampString.substring(12, 14), 10);

        const date = new Date(year, month - 1, day, hour, min, sec);
        return date.getTime();
    }

    clearFfmpegTimeout(videoPath: string) {
        const timeout = this.ffmpegGenerationTimeout.get(videoPath);
        if (timeout) {
            clearTimeout(timeout);
            this.ffmpegGenerationTimeout.delete(videoPath);
        }
    }

    async getVideoDurationWithFFmpeg(videoPath: string): Promise<number | null> {
        const logger = this.getLogger();

        return new Promise(async (resolve, reject) => {
            try {
                await fs.promises.access(videoPath);

                const ffmpeg = spawn(this.plugin.ffmpegPath, [
                    '-i', videoPath,
                    '-f', 'null',
                    '-'
                ], {
                    stdio: ['pipe', 'pipe', 'pipe']
                });

                let stderr = '';

                ffmpeg.stderr.on('data', (data) => {
                    stderr += data.toString();
                });

                ffmpeg.on('close', () => {
                    try {
                        const durationMatch = stderr.match(/Duration: (\d{2}):(\d{2}):(\d{2})\.(\d{2})/);

                        if (durationMatch) {
                            const hours = parseInt(durationMatch[1], 10);
                            const minutes = parseInt(durationMatch[2], 10);
                            const seconds = parseInt(durationMatch[3], 10);
                            const centiseconds = parseInt(durationMatch[4], 10);

                            const durationSeconds = (hours * 3600 + minutes * 60 + seconds) + centiseconds / 100;

                            logger.debug(`Video duration ${videoPath}: ${durationSeconds}s`);
                            this.clearFfmpegTimeout(videoPath);
                            resolve(durationSeconds);
                        } else {
                            logger.error(`Unable to extract duration from video: ${videoPath}`, stderr);
                            this.clearFfmpegTimeout(videoPath);
                            resolve(null);
                        }
                    } catch (error) {
                        logger.error(`Error parsing duration for ${videoPath}:`, error);
                        this.clearFfmpegTimeout(videoPath);
                        reject(error);
                    }
                });

                ffmpeg.on('error', (error) => {
                    logger.error(`Error executing FFmpeg for ${videoPath}:`, error);
                    this.clearFfmpegTimeout(videoPath);
                    reject(error);
                });

                const timeout = setTimeout(() => {
                    ffmpeg.kill();
                    logger.error(`FFmpeg timeout for ${videoPath}`);
                    this.clearFfmpegTimeout(videoPath);
                    reject('timeout');
                }, 15000);
                this.ffmpegGenerationTimeout.set(videoPath, timeout);
            } catch {
                logger.error(`Videoclip not found: ${videoPath}`);
                reject('not found');
            }
        });
    }

    async getVideoClips(options?: VideoClipOptions, streamType: VideoSearchType = 'main') {
        const logger = this.getLogger();
        try {
            const { ftp } = this.storageSettings.values;
            const parsedFolder = this.getFtpParsedDirectory();

            const videoclips: VideoClip[] = [];

            if (ftp) {
                const files = await fs.promises.readdir(parsedFolder) || [];
                const filtered = files.filter(file => file.endsWith('.mp4'));
                for (const item of filtered) {
                    const [timestampString, duration] = item.split('.')[0].split('_');
                    const timestamp = Number(timestampString);

                    const videoclipPath = path.join(parsedFolder, item);

                    const event = 'motion';
                    const { thumbnailUrl, videoclipUrl } = await this.getVideoclipWebhookUrls(videoclipPath);

                    if (timestamp >= options.startTime && timestamp <= options.endTime) {
                        videoclips.push({
                            id: videoclipPath,
                            startTime: timestamp,
                            duration: Number(duration) * 1000,
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

            logger.info(`Videoclips found:`, JSON.stringify({
                videoclips,
            }));
            return videoclips;
        } catch (e) {
            logger.log('Error during get videoClips', e);
        }
    }

    async getVideoClip(videoId: string): Promise<MediaObject> {
        const logger = this.getLogger();
        logger.log('Fetching videoId ', videoId);
        const { videoclipUrl } = await this.getVideoclipWebhookUrls(videoId);
        const videoclipMo = await sdk.mediaManager.createMediaObject(videoclipUrl, 'video/mp4');

        return videoclipMo;
    }

    async generateThumbnail(videoclipPath: string) {
        const mo = await sdk.mediaManager.createFFmpegMediaObject({
            inputArguments: [
                '-ss', '00:00:05',
                '-i', videoclipPath,
            ],
        });
        const jpeg = await sdk.mediaManager.convertMediaObjectToBuffer(mo, 'image/jpeg');
        return jpeg;
    }

    async findFtpThumbnail(videoclipPath: string): Promise<Buffer | null> {
        const parts = videoclipPath.split('.')[0].split('_');
        const timestamp = Number(parts[parts.length - 1]);
        const fileNamePrefix = this.fileNamePrefix;
        const dir = path.dirname(videoclipPath);
        const logger = this.getLogger();

        let sameTimestamp: string;

        try {
            const jpgCandidates = fs.readdirSync(dir)
                .filter(file => {
                    const m = file.endsWith('.jpg') && file.includes(fileNamePrefix);
                    if (!m) return false;
                    const partsInner = file.split('.')[0].split('_');
                    const timestampInner = Number(partsInner[partsInner.length - 1]);

                    if (timestamp === timestampInner) {
                        sameTimestamp = file;
                        return true;
                    }

                    const diff = Math.abs(timestampInner - timestamp);
                    return diff <= 200;
                });

            const jpgNearby = sameTimestamp ?? jpgCandidates[0];

            if (jpgNearby) {
                const jpegPath = path.join(this.storageSettings.values.ftpFolder, jpgNearby);
                const jpegBuffer = await fs.promises.readFile(jpegPath);

                if (jpegBuffer.length > 0) {
                    logger.debug(`Found thumbnail buffer for video ${videoclipPath}: ${jpegBuffer.length} bytes`);
                    return jpegBuffer;
                } else {
                    logger.warn(`Thumbnail file is empty: ${jpegPath}`);
                    return null;
                }
            } else {
                logger.debug(`No thumbnail found for video: ${videoclipPath}`);
                return null;
            }
        } catch (error) {
            logger.error(`Error reading thumbnail for video ${videoclipPath}:`, error);
            return null;
        }
    }

    async getVideoClipThumbnail(thumbnailId: string, options?: VideoClipThumbnailOptions): Promise<MediaObject> {
        const logger = this.getLogger();
        const { thumbnailUrl } = await this.getVideoclipParams(thumbnailId);
        logger.log(`Fetching thumbnailId ${thumbnailId} from ${thumbnailUrl}`);
        try {
            const { ftp } = this.storageSettings.values;

            if (ftp) {
                const fileURLToPath = url.pathToFileURL(thumbnailUrl).toString();
                return await sdk.mediaManager.createMediaObjectFromUrl(fileURLToPath);
            } else {
                if (fs.existsSync(thumbnailUrl)) {
                    const fileURLToPath = url.pathToFileURL(thumbnailUrl).toString();
                    return await sdk.mediaManager.createMediaObjectFromUrl(fileURLToPath);
                } else {
                    logger.log(`Thumbnail ${thumbnailUrl} not found, adding to generation queue.`);
                    this.plugin.thumbnailsToGenerate.push({ thumbnailId, deviceId: this.id });
                    return null;
                }
            }
        } catch (e) {
            logger.error(`Error retrieving thumbnail of videoclip ${thumbnailId}`, e);

            return null;
        }
    }

    getFtpParsedDirectory() {
        const { ftpFolder } = this.storageSettings.values;

        return path.join(ftpFolder, 'parsed', this.id);
    }

    async getVideoclipParams(videoclipId?: string) {
        const { ftp, ftpFolder } = this.storageSettings.values;
        const { thumbnailFolder } = getFolderPaths(this.id, this.camera.plugin.storageSettings.values.downloadFolder);

        let videoclipUrl: string;
        let thumbnailUrl: string;
        if (ftp) {
            videoclipUrl = videoclipId;
            const parsedFolder = path.join(ftpFolder, 'parsed', this.id);
            if (videoclipId) {
                const [timestamp] = videoclipId.split('/').pop().split('.')[0].split('_');
                thumbnailUrl = path.join(parsedFolder, `${timestamp}.jpeg`);
            }
        } else {
            const api = await this.getClient();
            if (videoclipId) {
                const { downloadPathWithHost } = await api.getVideoClipUrl(
                    videoclipId,
                    this.camera.getRtspChannel(),
                );
                videoclipUrl = downloadPathWithHost;
                const filename = `${videoclipId.split('/').pop().split('.')[0]}`;
                const parsedFilename = filename.replaceAll(' ', '_');
                thumbnailUrl = path.join(thumbnailFolder, `${parsedFilename}.jpeg`);
            }
        }

        return { videoclipUrl, thumbnailFolder, thumbnailUrl };
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
