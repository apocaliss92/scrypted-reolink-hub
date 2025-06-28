import sdk, { DeviceCreatorSettings, DeviceInformation, HttpRequest, HttpRequestHandler, HttpResponse, Reboot, ScryptedDeviceType, ScryptedInterface, Setting, Settings, SettingValue, VideoClips } from "@scrypted/sdk";
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import fs from 'fs';
import http from 'http';
import { cleanup } from "../../scrypted-reolink-videoclips/src/utils";
import { DevInfo } from '../../scrypted/plugins/reolink/src/probe';
import { RtspProvider } from "../../scrypted/plugins/rtsp/src/rtsp";
import { name } from '../package.json';
import { ReolinkCamera } from "./camera";
import { ReolinkHubClient } from './reolink-api';
import ReolinkVideoclips from "./videoclips";

export const pluginId = name;
export const REOLINK_HUB_VIDEOCLIPS_INTERFACE = `${pluginId}:videoclips`;
export const videoclipsNativeId = 'reolinkHubVideoclips';

class ReolinkProvider extends RtspProvider implements Settings, HttpRequestHandler, Reboot {
    client: ReolinkHubClient;
    videoclipsDevice: ReolinkVideoclips;

    storageSettings = new StorageSettings(this, {
        address: {
            title: 'HUB IP',
            type: 'string',
        },
        username: {
            title: 'Username',
            placeholder: 'admin',
            defaultValue: 'admin',
            type: 'string',
        },
        password: {
            title: 'Password',
            type: 'password',
        },
        port: {
            title: 'HTTP Port',
            subgroup: 'Advanced',
            defaultValue: 80,
            placeholder: '80',
            type: 'number',
        },
        rtspPort: {
            subgroup: 'Advanced',
            title: 'RTSP Port',
            placeholder: '554',
            defaultValue: 554,
            type: 'number'
        },
        eventsFetchSleep: {
            subgroup: 'Advanced',
            title: 'Seconds to wait between events fetching',
            description: 'Increase this number if the hub acts strangely',
            defaultValue: 2,
            type: 'number'
        },
        downloadFolder: {
            title: 'Directory where to cache thumbnails and videoclips',
            description: 'Default to the plugin folder',
            type: 'string',
            group: 'Videoclips'
        },
        clearDownloadedData: {
            title: 'clear stored data',
            type: 'button',
            group: 'Videoclips',
            onPut: async () => cleanup(this.storageSettings.values.downloadFolder)
        },
    });

    constructor() {
        super();

        this.init().catch(this.console.error);
    }

    async reboot() {
        const client = this.getClient();
        if (!client) {
            return;
        }

        await client.reboot();
    }

    async init() {
        const client = this.getClient();
        await client.login();

        setInterval(async () => {
            try {
                const client = this.getClient();
                await client.checkErrors();
            } catch (e) {
                this.console.log('Error on reconnect', e);
            }
        }, 1000 * 60);

        await sdk.deviceManager.onDeviceDiscovered(
            {
                name: 'Reolink HUB Videoclips',
                nativeId: videoclipsNativeId,
                interfaces: [ScryptedInterface.MixinProvider, ScryptedInterface.Settings],
                type: ScryptedDeviceType.API,
            }
        );
    }

    async onRequest(request: HttpRequest, response: HttpResponse): Promise<void> {
        const url = new URL(`http://localhost${request.url}`);
        const params = url.searchParams.get('params') ?? '{}';

        try {
            const [_, __, ___, ____, _____, webhook] = url.pathname.split('/');
            const { nativeId, videoclipPath } = JSON.parse(params);
            const dev = this.devices.get(nativeId);
            const deviceId = dev.id;
            const devConsole = dev.console;
            const actualDevice = sdk.systemManager.getDeviceById<VideoClips>(deviceId);

            try {
                if (webhook === 'videoclip') {
                    if (dev.storageSettings.values.ftp) {

                        const stat = fs.statSync(videoclipPath);
                        const fileSize = stat.size;
                        const range = request.headers.range;

                        if (range) {
                            const parts = range.replace(/bytes=/, "").split("-");
                            const start = parseInt(parts[0], 10);
                            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

                            const chunksize = (end - start) + 1;
                            const file = fs.createReadStream(videoclipPath, { start, end });

                            const sendVideo = async () => {
                                return new Promise<void>((resolve, reject) => {
                                    try {
                                        response.sendStream((async function* () {
                                            for await (const chunk of file) {
                                                yield chunk;
                                            }
                                        })(), {
                                            code: 206,
                                            headers: {
                                                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                                                'Accept-Ranges': 'bytes',
                                                'Content-Length': chunksize,
                                                'Content-Type': 'video/mp4',
                                            }
                                        });

                                        resolve();
                                    } catch (err) {
                                        reject(err);
                                    }
                                });
                            };

                            try {
                                await sendVideo();
                                return;
                            } catch (e) {
                                devConsole.log('Error fetching videoclip', e);
                            }
                        } else {
                            response.sendFile(videoclipPath, {
                                code: 200,
                                headers: {
                                    'Content-Length': fileSize,
                                    'Content-Type': 'video/mp4',
                                }
                            });
                        }

                        return;
                    } else {
                        const api = this.getClient();

                        const { downloadPathWithHost } = await api.getVideoClipUrl(videoclipPath, deviceId);

                        const sendVideo = async () => {
                            return new Promise<void>((resolve, reject) => {
                                http.get(downloadPathWithHost, { headers: request.headers }, (httpResponse) => {
                                    if (httpResponse.statusCode[0] === 400) {
                                        reject(new Error(`Error loading the video: ${httpResponse.statusCode} - ${httpResponse.statusMessage}. Headers: ${JSON.stringify(request.headers)}`));
                                        return;
                                    }

                                    try {
                                        response.sendStream((async function* () {
                                            for await (const chunk of httpResponse) {
                                                yield chunk;
                                            }
                                        })(), {
                                            headers: httpResponse.headers
                                        });

                                        resolve();
                                    } catch (err) {
                                        reject(err);
                                    }
                                }).on('error', (e) => {
                                    devConsole.log('Error fetching videoclip', e);
                                    reject(e)
                                });
                            });
                        };

                        try {
                            await sendVideo();
                            return;
                        } catch (e) {
                            devConsole.log('Error fetching videoclip', e);
                        }
                    }
                } else
                    if (webhook === 'thumbnail') {
                        devConsole.log(`Thumbnail requested: ${JSON.stringify({
                            videoclipPath,
                            deviceId,
                        })}`);
                        const thumbnailMo = await actualDevice.getVideoClipThumbnail(videoclipPath);
                        const jpeg = await sdk.mediaManager.convertMediaObjectToBuffer(thumbnailMo, 'image/jpeg');
                        response.send(jpeg, {
                            headers: {
                                'Content-Type': 'image/jpeg',
                            }
                        });
                        return;
                    }
            } catch (e) {
                devConsole.log(`Error in webhook`, e);
                response.send(`${JSON.stringify(e)}, ${e.message}`, {
                    code: 400,
                });

                return;
            }

            response.send(`Webhook not found: ${url.pathname}`, {
                code: 404,
            });

            return;
        } catch (e) {
            this.console.log('Error in data parsing for webhook', e);
            response.send(`Error in data parsing for webhook: ${JSON.stringify({
                params,
                url: request.url
            })}`, {
                code: 500,
            });
        }
    }

    async getSettings(): Promise<Setting[]> {
        const settings = await this.storageSettings.getSettings();
        return settings;
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        this.client = undefined;
        return this.storageSettings.putSetting(key, value);
    }

    getHttpAddress() {
        const { address, port } = this.storageSettings.values;
        return `${address}:${port}`;
    }

    getClient() {
        if (!this.client) {
            const { password, username } = this.storageSettings.values;
            this.client = new ReolinkHubClient(this.getHttpAddress(), username, password, this.console);
        }
        return this.client;
    }

    getScryptedDeviceCreator(): string {
        return 'Reolink HUB Camera';
    }

    getAdditionalInterfaces() {
        return [
            ScryptedInterface.VideoCameraConfiguration,
            ScryptedInterface.Camera,
            ScryptedInterface.AudioSensor,
            ScryptedInterface.MotionSensor,
            ScryptedInterface.VideoTextOverlays,
            ScryptedInterface.VideoTextOverlays,
            ScryptedInterface.MixinProvider,
            pluginId,
        ];
    }

    async getDevice(nativeId: string) {
        if (nativeId === videoclipsNativeId)
            return this.videoclipsDevice ||= new ReolinkVideoclips(videoclipsNativeId, this);

        return super.getDevice(nativeId);
    }

    async createDevice(settings: DeviceCreatorSettings, nativeId?: string): Promise<string> {
        let info: DeviceInformation = {};

        let name: string = 'Reolink Camera';
        let deviceInfo: DevInfo;
        let ai;
        let abilities;
        const rtspChannel = parseInt(settings.rtspChannel?.toString()) || 0;
        const api = this.getClient();
        try {
            await api.jpegSnapshot(rtspChannel);
        }
        catch (e) {
            this.console.error('Error adding Reolink camera', e);
            throw e;
        }

        try {
            deviceInfo = await api.getDeviceInfo(rtspChannel);
            name = deviceInfo.name ?? 'Reolink Camera';
            ai = await api.getAiState(rtspChannel);
            abilities = await api.getAbility(rtspChannel);
        }
        catch (e) {
            this.console.error('Reolink camera does not support AI events', e);
        }
        settings.newCamera ||= name;

        nativeId = await super.createDevice(settings, nativeId);

        const device = await this.getDevice(nativeId) as ReolinkCamera;
        device.info = info;
        device.storageSettings.values.deviceInfo = deviceInfo;
        device.storageSettings.values.abilities = abilities;
        device.storageSettings.values.hasObjectDetector = ai;
        device.storageSettings.values.rtspChannel = rtspChannel;

        device.updateDeviceInfo();

        return nativeId;
    }

    async getCreateDeviceSettings(): Promise<Setting[]> {
        return [
            {
                key: 'rtspChannel',
                title: 'Channel Number Override',
                description: "The channel number to use for snapshots and video. E.g., 0, 1, 2, etc.",
                placeholder: '0',
                type: 'number',
            }
        ]
    }

    createCamera(nativeId: string) {
        try {
            return new ReolinkCamera(nativeId, this);
        } catch (e) {
            this.console.log('Error creating device', nativeId, e)
        }
    }
}

export default ReolinkProvider;
