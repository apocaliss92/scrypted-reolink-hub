import { sleep } from '@scrypted/common/src/sleep';
import sdk, { Brightness, Camera, Device, DeviceProvider, Intercom, MediaObject, ObjectDetectionTypes, ObjectDetector, ObjectsDetected, OnOff, PanTiltZoom, PanTiltZoomCommand, RequestPictureOptions, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, Setting, Sleep, VideoTextOverlay, VideoTextOverlays } from "@scrypted/sdk";
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import { EventEmitter } from "stream";
import { connectCameraAPI, OnvifCameraAPI, OnvifEvent } from '../../scrypted/plugins/reolink/src/onvif-api';
import { listenEvents } from '../../scrypted/plugins/reolink/src/onvif-events';
import { OnvifIntercom } from '../../scrypted/plugins/reolink/src/onvif-intercom';
import { DevInfo } from '../../scrypted/plugins/reolink/src/probe';
import { createRtspMediaStreamOptions, Destroyable, RtspSmartCamera, UrlMediaStreamOptions } from "../../scrypted/plugins/rtsp/src/rtsp";
import ReolinkProvider from './main';
import { AIState, Enc } from './reolink-api';

export const moToB64 = async (mo: MediaObject) => {
    const bufferImage = await sdk.mediaManager.convertMediaObjectToBuffer(mo, 'image/jpeg');
    return bufferImage?.toString('base64');
}

export const b64ToMo = async (b64: string) => {
    const buffer = Buffer.from(b64, 'base64');
    return await sdk.mediaManager.createMediaObject(buffer, 'image/jpeg');
}

class ReolinkCameraSiren extends ScryptedDeviceBase implements OnOff {
    sirenTimeout: NodeJS.Timeout;

    constructor(public camera: ReolinkCamera, nativeId: string) {
        super(nativeId);
    }

    async turnOff() {
        this.on = false;
        await this.setSiren(false);
    }

    async turnOn() {
        this.on = true;
        await this.setSiren(true);
    }

    private async setSiren(on: boolean) {
        const api = this.camera.getClient();

        // doorbell doesn't seem to support alarm_mode = 'manul'
        if (this.camera.storageSettings.values.doorbell) {
            if (!on) {
                clearInterval(this.sirenTimeout);
                await api.setSiren(this.camera.getRtspChannel(), false);
                return;
            }

            // siren lasts around 4 seconds.
            this.sirenTimeout = setTimeout(async () => {
                await this.turnOff();
            }, 4000);

            await api.setSiren(this.camera.getRtspChannel(), true, 1);
            return;
        }
        await api.setSiren(this.camera.getRtspChannel(), on);
    }
}

class ReolinkCameraFloodlight extends ScryptedDeviceBase implements OnOff, Brightness {
    constructor(public camera: ReolinkCamera, nativeId: string) {
        super(nativeId);
    }

    async setBrightness(brightness: number): Promise<void> {
        this.brightness = brightness;
        await this.setFloodlight(undefined, brightness);
    }

    async turnOff() {
        this.on = false;
        await this.setFloodlight(false);
    }

    async turnOn() {
        this.on = true;
        await this.setFloodlight(true);
    }

    private async setFloodlight(on?: boolean, brightness?: number) {
        const api = this.camera.getClient();

        await api.setWhiteLedState(this.camera.getRtspChannel(), on, brightness);
    }
}

class ReolinkCameraPirSensor extends ScryptedDeviceBase implements OnOff {
    constructor(public camera: ReolinkCamera, nativeId: string) {
        super(nativeId);
    }

    async turnOff() {
        this.on = false;
        await this.setPir(false);
    }

    async turnOn() {
        this.on = true;
        await this.setPir(true);
    }

    private async setPir(on: boolean) {
        const api = this.camera.getClient();

        await api.setPirState(this.camera.getRtspChannel(), on);
    }
}

export class ReolinkCamera extends RtspSmartCamera implements Camera, DeviceProvider, Intercom, ObjectDetector, PanTiltZoom, Sleep, VideoTextOverlays {
    onvifClient: OnvifCameraAPI;
    onvifIntercom = new OnvifIntercom(this);
    videoStreamOptions: Promise<UrlMediaStreamOptions[]>;
    motionTimeout: NodeJS.Timeout;
    siren: ReolinkCameraSiren;
    floodlight: ReolinkCameraFloodlight;
    pirSensor: ReolinkCameraPirSensor;
    batteryTimeout: NodeJS.Timeout;
    isWifi: boolean;
    lastB64Snapshot: string;
    lastSnapshotTaken: number;
    plugin: ReolinkProvider;
    lastConnection: number;

    storageSettings = new StorageSettings(this, {
        doorbell: {
            title: 'Doorbell',
            description: 'This camera is a Reolink Doorbell.',
            type: 'boolean',
        },
        rtspChannel: {
            subgroup: 'Advanced',
            title: 'Channel',
            type: 'number',
        },
        motionTimeout: {
            subgroup: 'Advanced',
            title: 'Motion Timeout',
            defaultValue: 20,
            type: 'number',
        },
        hasObjectDetector: {
            json: true,
            hide: true,
        },
        ptz: {
            subgroup: 'Advanced',
            title: 'PTZ Capabilities',
            choices: [
                'Pan',
                'Tilt',
                'Zoom',
            ],
            multiple: true,
            onPut: async () => {
                await this.updateDevice();
                this.updatePtzCaps();
            },
        },
        presets: {
            subgroup: 'Advanced',
            title: 'Presets',
            description: 'PTZ Presets in the format "id=name". Where id is the PTZ Preset identifier and name is a friendly name.',
            multiple: true,
            defaultValue: [],
            combobox: true,
            onPut: async (ov, presets: string[]) => {
                const caps = {
                    ...this.ptzCapabilities,
                    presets: {},
                };
                for (const preset of presets) {
                    const [key, name] = preset.split('=');
                    caps.presets[key] = name;
                }
                this.ptzCapabilities = caps;
            },
            mapGet: () => {
                const presets = this.ptzCapabilities?.presets || {};
                return Object.entries(presets).map(([key, name]) => key + '=' + name);
            },
        },
        cachedPresets: {
            multiple: true,
            hide: true,
            json: true,
            defaultValue: [],
        },
        deviceInfo: {
            json: true,
            hide: true
        },
        abilities: {
            json: true,
            hide: true
        },
        useOnvifDetections: {
            subgroup: 'Advanced',
            title: 'Use ONVIF for Object Detection',
            choices: [
                'Default',
                'Enabled',
                'Disabled',
            ],
            defaultValue: 'Default',
        },
        useOnvifTwoWayAudio: {
            subgroup: 'Advanced',
            title: 'Use ONVIF for Two-Way Audio',
            type: 'boolean',
        },
    });

    constructor(nativeId: string, provider: ReolinkProvider) {
        super(nativeId, provider);
        this.plugin = provider;

        this.storageSettings.settings.useOnvifTwoWayAudio.onGet = async () => {
            return {
                hide: !!this.storageSettings.values.doorbell,
            }
        };

        this.storageSettings.settings.ptz.onGet = async () => {
            return {
                hide: !!this.storageSettings.values.doorbell,
            }
        };

        this.storageSettings.settings.presets.onGet = async () => {
            const choices = this.storageSettings.values.cachedPresets.map((preset) => preset.id + '=' + preset.name);
            return {
                choices,
            };
        };

        this.init().catch(this.console.error);
    }

    async init() {
        setTimeout(async () => {
            const api = this.getClient();

            while (!this.plugin.client.loggedIn) {
                this.console.log('Waiting for plugin connection');
                await sleep(3000);
            }

            this.updatePtzCaps();
            try {
                await this.getPresets();
            } catch (e) {
                this.console.log('Fail fetching presets', e);
            }
            const deviceInfo = await api.getDeviceInfo(this.getRtspChannel());
            this.console.log('deviceInfo', JSON.stringify(deviceInfo));
            this.storageSettings.values.deviceInfo = deviceInfo;
            await this.updateAbilities();
            await this.updateDevice();
            await this.reportDevices();
            this.startDevicesStatesPolling();
            this.updateDeviceInfo();

            // const currentPrebuffer = this.storage.getItem('prebuffer:enabledStreams');
            // if (this.hasBattery() && !currentPrebuffer) {
            //     this.console.log('Disabling prebbufer for battery cam');
            //     super.putSetting('prebuffer:enabledStreams', []);
            // }
        }, 5000);
    }

    getClient() {
        return this.plugin.getClient();
    }

    async pollDeviceStates() {
        try {
            const api = this.getClient();
            if (!api) {
                return;
            }

            try {
                if (this.hasFloodlight() && this.floodlight) {
                    const { enabled } = await api.getWhiteLedState(this.getRtspChannel());

                    if (enabled !== this.floodlight.on) {
                        this.floodlight.on = enabled;
                    }
                }
            } catch { }

            try {
                if (this.hasPirSensor() && this.pirSensor) {
                    const { enabled } = await api.getPirState(this.getRtspChannel());

                    if (enabled !== this.pirSensor.on) {
                        this.pirSensor.on = enabled;
                    }
                }
            } catch { }
        } catch (e) {
            this.console.error('Error in pollDeviceStates', e);
        }
    }

    async startDevicesStatesPolling() {
        if (
            !this.hasBattery() &&
            (this.hasFloodlight() || this.hasSiren() || this.hasPirSensor())
        ) {
            while (true) {
                await this.pollDeviceStates();
                await sleep(1000 * 5);
            }
        }
    }

    async getVideoTextOverlays(): Promise<Record<string, VideoTextOverlay>> {
        const client = this.getClient();
        if (!client) {
            return;
        }
        const osd = await client.getOsd(this.getRtspChannel());

        return {
            osdChannel: {
                text: osd.value.Osd.osdChannel.enable ? osd.value.Osd.osdChannel.name : undefined,
            },
            osdTime: {
                text: !!osd.value.Osd.osdTime.enable,
                readonly: true,
            }
        }
    }

    async setVideoTextOverlay(id: 'osdChannel' | 'osdTime', value: VideoTextOverlay): Promise<void> {
        const client = this.getClient();
        if (!client) {
            return;
        }

        const osd = await client.getOsd(this.getRtspChannel());
        if (id === 'osdChannel') {
            const osdValue = osd.value.Osd.osdChannel;
            osdValue.enable = value.text ? 1 : 0;
            // name must always be valid.
            osdValue.name = typeof value.text === 'string' && value.text
                ? value.text
                : osdValue.name || 'Camera';
        }
        else if (id === 'osdTime') {
            const osdValue = osd.value.Osd.osdTime;
            osdValue.enable = value.text ? 1 : 0;
        }
        else {
            throw new Error('unknown overlay: ' + id);
        }

        await client.setOsd(this.getRtspChannel(), osd);
    }

    updatePtzCaps() {
        const { ptz } = this.storageSettings.values;
        this.ptzCapabilities = {
            ...this.ptzCapabilities,
            pan: ptz?.includes('Pan'),
            tilt: ptz?.includes('Tilt'),
            zoom: ptz?.includes('Zoom'),
        }
    }

    async getPresets() {
        const client = this.getClient();
        if (!client) {
            return;
        }
        const ptzPresets = await client.getPtzPresets(this.getRtspChannel());
        // this.console.log(`Presets: ${JSON.stringify(ptzPresets)}`)
        this.storageSettings.values.cachedPresets = ptzPresets;
    }

    async updateAbilities() {
        const api = this.getClient();
        if (!api) {
            return;
        }

        let abilities;
        try {
            abilities = await api.getAbility(this.getRtspChannel());
        } catch (e) {
        }
        try {
            const { isWifi } = await api.getLocalLink(this.getRtspChannel());
            this.isWifi = isWifi;
        } catch { }

        this.storageSettings.values.abilities = abilities;
        // this.console.log('getAbility', JSON.stringify(abilities));
    }

    supportsOnvifDetections() {
        const onvif: string[] = [
            // wifi
            'CX410W',
            'Reolink Video Doorbell WiFi',

            // poe
            'CX410',
            'CX810',
            'Reolink Video Doorbell PoE',
        ];
        return onvif.includes(this.storageSettings.values.deviceInfo?.model);
    }

    async getDetectionInput(detectionId: string, eventId?: any): Promise<MediaObject> {
        return;
    }

    async ptzCommand(command: PanTiltZoomCommand): Promise<void> {
        const client = this.getClient();
        if (!client) {
            return;
        }
        client.ptz(this.getRtspChannel(), command);
    }

    async getObjectTypes(): Promise<ObjectDetectionTypes> {
        try {
            const ai: AIState = this.storageSettings.values.hasObjectDetector?.value;
            const classes: string[] = [];

            for (const key of Object.keys(ai ?? {})) {
                if (key === 'channel')
                    continue;
                const { alarm_state, support } = ai[key];
                if (support)
                    classes.push(key);
            }
            return {
                classes,
            };
        }
        catch (e) {
            return {
                classes: [],
            };
        }
    }

    async startIntercom(media: MediaObject): Promise<void> {
        if (!this.onvifIntercom.url) {
            const client = await this.getOnvifClient();
            const streamUrl = await client.getStreamUrl();
            this.onvifIntercom.url = streamUrl;
        }
        return this.onvifIntercom.startIntercom(media);
    }

    stopIntercom(): Promise<void> {
        return this.onvifIntercom.stopIntercom();
    }

    hasSiren() {
        const channel = this.getRtspChannel();
        const hasAbility = this.storageSettings.values.abilities?.value?.Ability?.abilityChn?.[channel]?.supportAudioAlarm

        return (hasAbility && hasAbility?.ver !== 0);

    }

    hasFloodlight() {
        const channel = this.getRtspChannel();

        const channelData = this.storageSettings.values.abilities?.value?.Ability?.abilityChn?.[channel];
        if (channelData) {
            const floodLightConfigVer = channelData.floodLight?.ver ?? 0;
            const supportFLswitchConfigVer = channelData.supportFLswitch?.ver ?? 0;
            const supportFLBrightnessConfigVer = channelData.supportFLBrightness?.ver ?? 0;

            return floodLightConfigVer > 0 || supportFLswitchConfigVer > 0 || supportFLBrightnessConfigVer > 0;
        }

        return false;
    }

    hasBattery() {
        const batteryConfigVer = this.storageSettings.values.abilities?.value?.Ability?.abilityChn?.[this.getRtspChannel()]?.battery?.ver ?? 0;
        return batteryConfigVer > 0;
    }

    hasPirEvents() {
        const pirEvents = this.storageSettings.values.abilities?.value?.Ability?.abilityChn?.[this.getRtspChannel()]?.mdWithPir?.ver ?? 0;
        return pirEvents > 0;
    }

    hasPirSensor() {
        const batteryConfigVer = this.storageSettings.values.abilities?.value?.Ability?.abilityChn?.[this.getRtspChannel()]?.mdWithPir?.ver ?? 0;
        return batteryConfigVer > 0;
    }

    async updateDevice() {
        const interfaces = this.provider.getInterfaces();
        let type = ScryptedDeviceType.Camera;
        let name = 'Reolink Camera';
        if (this.storageSettings.values.doorbell) {
            interfaces.push(
                ScryptedInterface.BinarySensor,
            );
            type = ScryptedDeviceType.Doorbell;
            name = 'Reolink Doorbell';
        }
        if (this.storageSettings.values.doorbell || this.storageSettings.values.useOnvifTwoWayAudio) {
            interfaces.push(
                ScryptedInterface.Intercom
            );
        }

        if (this.storageSettings.values.ptz?.length) {
            interfaces.push(ScryptedInterface.PanTiltZoom);
        }
        if (this.storageSettings.values.hasObjectDetector) {
            interfaces.push(ScryptedInterface.ObjectDetector);
        }
        if (this.hasSiren() || this.hasFloodlight() || this.hasPirSensor())
            interfaces.push(ScryptedInterface.DeviceProvider);
        if (this.hasBattery()) {
            interfaces.push(ScryptedInterface.Battery, ScryptedInterface.Sleep);
            this.startBatteryCheckInterval();
        }

        await this.provider.updateDevice(this.nativeId, this.name ?? name, interfaces, type);
    }

    startBatteryCheckInterval() {
        if (this.batteryTimeout) {
            clearInterval(this.batteryTimeout);
        }

        this.batteryTimeout = setInterval(async () => {
            const api = this.getClient();
            if (!api?.loggedIn) {
                return;
            }

            try {
                const { batteryPercent, sleeping } = await api.getBatteryInfo(this.getRtspChannel());
                this.batteryLevel = batteryPercent;

                if (sleeping !== this.sleeping) {
                    this.sleeping = sleeping;
                    if (!sleeping) {
                        await this.pollDeviceStates();
                    }
                }
                if (batteryPercent !== this.batteryLevel) {
                    this.batteryLevel = batteryPercent;
                }
            }
            catch (e) {
                this.console.log('Error in getting battery info', e);
            }
        }, 1000 * 10);
    }

    updateDeviceInfo() {
        const ip = this.plugin.storageSettings.values.address
        if (!ip)
            return;
        const info = this.info || {};
        info.ip = ip;
        info.serialNumber = this.storageSettings.values.deviceInfo?.serial;
        info.firmware = this.storageSettings.values.deviceInfo?.firmVer;
        info.version = this.storageSettings.values.deviceInfo?.hardVer;
        info.model = this.storageSettings.values.deviceInfo?.model;
        info.manufacturer = 'Reolink';
        info.managementUrl = `http://${ip}`;
        this.info = info;
    }

    async getOnvifClient() {
        if (!this.onvifClient)
            this.onvifClient = await this.createOnvifClient();
        return this.onvifClient;
    }

    createOnvifClient() {
        const { username, password } = this.plugin.storageSettings.values;
        return connectCameraAPI(this.plugin.getHttpAddress(), username, password, this.console, this.storageSettings.values.doorbell ? this.storage.getItem('onvifDoorbellEvent') : undefined);
    }

    async listenEvents() {
        let killed = false;
        const client = this.getClient();

        // reolink ai might not trigger motion if objects are detected, weird.
        const startAI = async (ret: Destroyable, triggerMotion: () => void) => {
            let hasSet = false;
            while (!killed) {
                try {
                    const ai = this.hasPirEvents() ? await client.getEvents(this.getRtspChannel()) : await client.getAiState(this.getRtspChannel());
                    ret.emit('data', JSON.stringify(ai.data));

                    const classes: string[] = [];

                    for (const key of Object.keys(ai.value ?? {})) {
                        if (key === 'channel')
                            continue;
                        const { support } = ai.value[key];
                        if (support)
                            classes.push(key);
                    }

                    if (!classes.length)
                        return;


                    if (!hasSet) {
                        hasSet = true;
                        this.storageSettings.values.hasObjectDetector = ai;
                    }

                    const od: ObjectsDetected = {
                        timestamp: Date.now(),
                        detections: [],
                    };
                    for (const c of classes) {
                        const { alarm_state } = ai.value[c];
                        if (alarm_state) {
                            od.detections.push({
                                className: c,
                                score: 1,
                            });
                        }
                    }
                    if (od.detections.length) {
                        triggerMotion();
                        sdk.deviceManager.onDeviceEvent(this.nativeId, ScryptedInterface.ObjectDetector, od);
                    }
                }
                catch (e) {
                    ret.emit('error', e);
                }
                await sleep(1000 * this.plugin.storageSettings.values.eventsFetchSleep);
            }
        }

        const useOnvifDetections: boolean = (this.storageSettings.values.useOnvifDetections === 'Default'
            && (this.supportsOnvifDetections() || this.storageSettings.values.doorbell))
            || this.storageSettings.values.useOnvifDetections === 'Enabled';
        if (useOnvifDetections) {
            const ret = await listenEvents(this, await this.createOnvifClient(), this.storageSettings.values.motionTimeout * 1000);
            ret.on('onvifEvent', (eventTopic: string, dataValue: any) => {
                let className: string;
                if (eventTopic.includes('PeopleDetect')) {
                    className = 'people';
                }
                else if (eventTopic.includes('FaceDetect')) {
                    className = 'face';
                }
                else if (eventTopic.includes('VehicleDetect')) {
                    className = 'vehicle';
                }
                else if (eventTopic.includes('DogCatDetect')) {
                    className = 'dog_cat';
                }
                else if (eventTopic.includes('Package')) {
                    className = 'package';
                }
                if (className && dataValue) {
                    ret.emit('event', OnvifEvent.MotionStart);

                    const od: ObjectsDetected = {
                        timestamp: Date.now(),
                        detections: [
                            {
                                className,
                                score: 1,
                            }
                        ],
                    };
                    sdk.deviceManager.onDeviceEvent(this.nativeId, ScryptedInterface.ObjectDetector, od);
                }
                else {
                    ret.emit('event', OnvifEvent.MotionStop);
                }
            });

            ret.on('close', () => killed = true);
            ret.on('error', () => killed = true);
            return ret;
        }

        const events = new EventEmitter();
        const ret: Destroyable = {
            on: function (eventName: string | symbol, listener: (...args: any[]) => void): void {
                events.on(eventName, listener);
            },
            destroy: function (): void {
                killed = true;
            },
            emit: function (eventName: string | symbol, ...args: any[]): boolean {
                return events.emit(eventName, ...args);
            }
        };

        const triggerMotion = () => {
            this.motionDetected = true;
            clearTimeout(this.motionTimeout);
            this.motionTimeout = setTimeout(() => this.motionDetected = false, this.storageSettings.values.motionTimeout * 1000);
        };
        (async () => {
            while (!killed) {
                try {
                    // Battey cameras do not have AI state, they just send events in case of PIR sensor triggered
                    // which equals a motion detected
                    if (this.hasPirEvents()) {
                        const { value, data } = await client.getEvents(this.getRtspChannel());
                        if (!!value?.other?.alarm_state)
                            triggerMotion();
                        ret.emit('data', JSON.stringify(data));
                    } else {
                        const { value, data } = await client.getMotionState(this.getRtspChannel());
                        if (value)
                            triggerMotion();
                        ret.emit('data', JSON.stringify(data));
                    }
                }
                catch (e) {
                    ret.emit('error', e);
                }
                await sleep(1000 * this.plugin.storageSettings.values.eventsFetchSleep);
            }
        })();

        startAI(ret, triggerMotion);
        return ret;
    }

    async takeSmartCameraPicture(options?: RequestPictureOptions): Promise<MediaObject> {
        const client = this.getClient();
        if (!client) {
            return;
        }

        const isEvent = options?.reason === 'event';
        const isBattery = this.hasBattery();
        const batteryThreshold = isEvent ? 2 : 5;

        let canTake = false;
        if (this.sleeping) {
            canTake = false;
        } else {
            const now = Date.now();
            if (isBattery) {
                if (!this.lastSnapshotTaken || (now - this.lastSnapshotTaken) > batteryThreshold) {
                    canTake = true;
                } else {
                    canTake = false;
                }
            } else {
                canTake = true;
            }
        }

        if (canTake) {
            const mo = await this.createMediaObject(await client.jpegSnapshot(this.getRtspChannel(), options?.timeout), 'image/jpeg');
            this.lastB64Snapshot = await moToB64(mo);

            return mo;
        } else {
            const mo = await b64ToMo(this.lastB64Snapshot);

            return mo;
        }
    }

    getRtspChannel() {
        return this.storageSettings.values.rtspChannel;
    }

    createRtspMediaStreamOptions(url: string, index: number) {
        const ret = createRtspMediaStreamOptions(url, index);
        ret.tool = 'scrypted';
        return ret;
    }

    addRtspCredentials(rtspUrl: string) {
        const { username, password } = this.plugin.storageSettings.values;
        const url = new URL(rtspUrl);
        // if (url.protocol !== 'rtmp:') {
        url.username = username;
        url.password = password;
        // } else {
        // const params = url.searchParams;
        // for (const [k, v] of Object.entries(this.plugin.client.parameters)) {
        //     params.set(k, v);
        // }
        // }
        return url.toString();
    }

    async createVideoStream(vso: UrlMediaStreamOptions): Promise<MediaObject> {
        await this.plugin.client.login();
        return super.createVideoStream(vso);
    }

    async getConstructedVideoStreamOptions(): Promise<UrlMediaStreamOptions[]> {
        this.videoStreamOptions ||= this.getConstructedVideoStreamOptionsInternal().catch(e => {
            this.constructedVideoStreamOptions = undefined;
            throw e;
        });

        return this.videoStreamOptions;
    }

    async getConstructedVideoStreamOptionsInternal(): Promise<UrlMediaStreamOptions[]> {
        const client = this.getClient();
        if (!client) {
            return;
        }

        let deviceInfo: DevInfo;
        try {
            deviceInfo = await client.getDeviceInfo(this.getRtspChannel());
        } catch (e) {
            this.console.error("Unable to gather device information.", e);
        }

        let encoderConfig: Enc;
        try {
            encoderConfig = await client.getEncoderConfiguration(this.getRtspChannel());
        } catch (e) {
            this.console.error("Codec query failed. Falling back to known defaults.", e);
        }

        const rtspChannel = this.getRtspChannel();
        const channel = (rtspChannel + 1).toString().padStart(2, '0');

        const streams: UrlMediaStreamOptions[] = [
            // {
            //     name: '',
            //     id: 'main.bcs',
            //     container: 'rtmp',
            //     video: { width: 2560, height: 1920 },
            //     url: ''
            // },
            // {
            //     name: '',
            //     id: 'ext.bcs',
            //     container: 'rtmp',
            //     video: { width: 896, height: 672 },
            //     url: ''
            // },
            // {
            //     name: '',
            //     id: 'sub.bcs',
            //     container: 'rtmp',
            //     video: { width: 640, height: 480 },
            //     url: ''
            // },
            {
                name: '',
                id: `h264Preview_${channel}_main`,
                container: 'rtsp',
                video: { codec: 'h264', width: 2560, height: 1920 },
                url: ''
            },
            {
                name: '',
                id: `h264Preview_${channel}_sub`,
                container: 'rtsp',
                video: { codec: 'h264', width: 640, height: 480 },
                url: ''
            }
        ];

        // abilityChn->live
        // 0: not support
        // 1: support main/extern/sub stream
        // 2: support main/sub stream

        // const live = this.storageSettings.values.abilities?.value?.Ability?.abilityChn?.[rtspChannel]?.live?.ver;
        // const [rtmpMain, rtmpExt, rtmpSub, rtspMain, rtspSub] = streams;
        // streams.splice(0, streams.length);

        // abilityChn->mainEncType
        // 0: main stream enc type is H264
        // 1: main stream enc type is H265

        // anecdotally, encoders of type h265 do not have a working RTMP main stream.
        // const mainEncType = this.storageSettings.values.abilities?.value?.Ability?.abilityChn?.[rtspChannel]?.mainEncType?.ver;

        // if (live === 2) {
        //     if (mainEncType === 1) {
        //         streams.push(rtmpSub, rtspMain, rtspSub);
        //     }
        //     else {
        //         streams.push(rtmpMain, rtmpSub, rtspMain, rtspSub);
        //     }
        // }
        // else if (mainEncType === 1) {
        //     streams.push(rtmpExt, rtmpSub, rtspMain, rtspSub);
        // }
        // else {
        //     streams.push(rtmpMain, rtmpExt, rtmpSub, rtspMain, rtspSub);
        // }


        // https://github.com/starkillerOG/reolink_aio/blob/main/reolink_aio/api.py#L93C1-L97C2
        // single motion models have 2*2 RTSP channels
        if (deviceInfo?.model &&
            [
                "Reolink TrackMix PoE",
                "Reolink TrackMix WiFi",
                "RLC-81MA",
                "Trackmix Series W760"
            ].includes(deviceInfo?.model)) {
            if (rtspChannel === 0) {
                streams.push({
                    name: '',
                    id: `h264Preview_02_main`,
                    container: 'rtsp',
                    video: { codec: 'h264', width: 3840, height: 2160 },
                    url: ''
                }, {
                    name: '',
                    id: `h264Preview_02_sub`,
                    container: 'rtsp',
                    video: { codec: 'h264', width: 640, height: 480 },
                    url: ''
                })
            }
        }

        for (const stream of streams) {
            var streamUrl;
            // if (stream.container === 'rtmp') {
            //     streamUrl = new URL(`rtmp://${this.getRtmpAddress()}/bcs/channel${rtspChannel}_${stream.id}`)
            //     const params = streamUrl.searchParams;
            //     params.set("channel", rtspChannel.toString())
            //     params.set("stream", '0')
            //     stream.url = streamUrl.toString();
            //     stream.name = `RTMP ${stream.id}`;
            // } else 
            if (stream.container === 'rtsp') {
                streamUrl = new URL(`rtsp://${this.getRtspAddress()}/${stream.id}`)
                stream.url = streamUrl.toString();
                stream.name = `RTSP ${stream.id}`;
            }
        }

        if (encoderConfig) {
            const { mainStream } = encoderConfig;
            if (mainStream?.width && mainStream?.height) {
                for (const stream of streams) {
                    if (stream.id === 'main.bcs' || stream.id === `h264Preview_${channel}_main`) {
                        stream.video.width = mainStream.width;
                        stream.video.height = mainStream.height;
                    }
                    // 4k h265 rtmp is seemingly nonfunctional, but rtsp works. swap them so there is a functional stream.
                    if (mainStream.vType === 'h265' || mainStream.vType === 'hevc') {
                        if (stream.id === `h264Preview_${channel}_main`) {
                            this.console.warn('Detected h265. Change the camera configuration to use 2k mode to force h264. https://docs.scrypted.app/camera-preparation.html#h-264-video-codec');
                            stream.video.codec = 'h265';
                            stream.id = `h265Preview_${channel}_main`;
                            stream.name = `RTSP ${stream.id}`;
                            stream.url = `rtsp://${this.getRtspAddress()}/${stream.id}`;
                            if (this.hasBattery()) {
                                stream.allowBatteryPrebuffer = false;
                            }
                            // Per Reolink:
                            // https://support.reolink.com/hc/en-us/articles/360007010473-How-to-Live-View-Reolink-Cameras-via-VLC-Media-Player/
                            // Note: the 4k cameras connected with the 4k NVR system will only show a fluent live stream instead of the clear live stream due to the H.264+(h.265) limit.
                        }
                    }
                }
            }
        }

        return streams;
    }

    async getSettings(): Promise<Setting[]> {
        const settings = await this.storageSettings.getSettings();
        return settings;
    }

    async putSetting(key: string, value: string) {
        if (this.storageSettings.keys[key]) {
            await this.storageSettings.putSetting(key, value);
        }
        else {
            await super.putSetting(key, value);
        }
        this.updateDevice();
        this.updateDeviceInfo();
    }

    showRtspUrlOverride() {
        return false;
    }

    getRtspAddress() {
        const { address, rtspPort } = this.plugin.storageSettings.values;
        return `${address}:${rtspPort}`;
    }

    // getRtmpAddress() {
    //     return `${this.getIPAddress()}:${this.storage.getItem('rtmpPort') || 1935}`;
    // }

    async reportDevices() {
        const hasSiren = this.hasSiren();
        const hasFloodlight = this.hasFloodlight();
        const hasPirSensor = this.hasPirSensor();

        const devices: Device[] = [];

        if (hasSiren) {
            const sirenNativeId = `${this.nativeId}-siren`;
            const sirenDevice: Device = {
                providerNativeId: this.nativeId,
                name: `${this.name} Siren`,
                nativeId: sirenNativeId,
                info: {
                    ...this.info,
                },
                interfaces: [
                    ScryptedInterface.OnOff
                ],
                type: ScryptedDeviceType.Siren,
            };

            devices.push(sirenDevice);
        }

        if (hasFloodlight) {
            const floodlightNativeId = `${this.nativeId}-floodlight`;
            const floodlightDevice: Device = {
                providerNativeId: this.nativeId,
                name: `${this.name} Floodlight`,
                nativeId: floodlightNativeId,
                info: {
                    ...this.info,
                },
                interfaces: [
                    ScryptedInterface.OnOff
                ],
                type: ScryptedDeviceType.Light,
            };

            devices.push(floodlightDevice);
        }

        if (hasPirSensor) {
            const pirNativeId = `${this.nativeId}-pir`;
            const pirDevice: Device = {
                providerNativeId: this.nativeId,
                name: `${this.name} PIR sensor`,
                nativeId: pirNativeId,
                info: {
                    ...this.info,
                },
                interfaces: [
                    ScryptedInterface.OnOff
                ],
                type: ScryptedDeviceType.Switch,
            };

            devices.push(pirDevice);
        }

        sdk.deviceManager.onDevicesChanged({
            providerNativeId: this.nativeId,
            devices
        });
    }

    async getDevice(nativeId: string): Promise<any> {
        if (nativeId.endsWith('-siren')) {
            this.siren ||= new ReolinkCameraSiren(this, nativeId);
            return this.siren;
        } else if (nativeId.endsWith('-floodlight')) {
            this.floodlight ||= new ReolinkCameraFloodlight(this, nativeId);
            return this.floodlight;
        } else if (nativeId.endsWith('-pir')) {
            this.pirSensor ||= new ReolinkCameraPirSensor(this, nativeId);
            return this.pirSensor;
        }
    }

    async releaseDevice(id: string, nativeId: string) {
        if (nativeId.endsWith('-siren')) {
            delete this.siren;
        } else if (nativeId.endsWith('-floodlight')) {
            delete this.floodlight;
        } else if (nativeId.endsWith('-pir')) {
            delete this.pirSensor;
        }
    }
}
