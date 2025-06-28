import { AuthFetchCredentialState, authHttpFetch } from '@scrypted/common/src/http-auth-fetch';
import { PassThrough, Readable } from 'stream';

import { sleep } from "@scrypted/common/src/sleep";
import { PanTiltZoomCommand, VideoClipOptions } from "@scrypted/sdk";
import { DevInfo, getLoginParameters } from '../../scrypted/plugins/reolink/src/probe';
import { HttpFetchOptions } from '../../scrypted/server/src/fetch/http-fetch';
import { VideoSearchResult, VideoSearchType } from '../../scrypted-reolink-videoclips/src/client';

export interface Enc {
    audio: number;
    channel: number;
    mainStream: Stream;
    subStream: Stream;
}

export interface Stream {
    bitRate: number;
    frameRate: number;
    gop: number;
    height: number;
    profile: string;
    size: string;
    vType: string;
    width: number;
}

export interface PurpleOsdChannel {
    enable: number;
    name: string;
    pos: string;
}

export interface PurpleOsdTime {
    enable: number;
    pos: string;
}
export interface InitialOsd {
    bgcolor: number;
    channel: number;
    osdChannel: PurpleOsdChannel;
    osdTime: PurpleOsdTime;
    watermark: number;
}

export interface Initial {
    Osd: InitialOsd;
}

export interface Osd {
    cmd: string;
    code: number;
    initial: Initial;
    range: Range;
    value: Initial;
}


export interface AIDetectionState {
    alarm_state: number;
    support: number;
}

type AiKey = 'dog_cat' | 'face' | 'other' | 'package' | 'people';

export type AIState = Partial<Record<AiKey, AIDetectionState>> & {
    channel: number;
};

export type SirenResponse = {
    rspCode: number;
}

export interface PtzPreset {
    id: number;
    name: string;
}

export class ReolinkHubClient {
    credential: AuthFetchCredentialState;
    parameters: Record<string, string>;
    tokenLease: number;
    loggingIn = false;
    loggedIn = false;
    rebooting = false;
    conmnectionTime = Date.now();

    maxSessionsCount = 0;
    loginFirstCount = 0;

    constructor(public host: string, public username: string, public password: string, public console: Console) {
        this.credential = {
            username,
            password,
        };
    }

    private async request(options: HttpFetchOptions<Readable>, body?: Readable) {
        const response = await authHttpFetch({
            ...options,
            rejectUnauthorized: false,
            credential: this.credential,
            body,
        });
        return response;
    }

    private createReadable = (data: any) => {
        const pt = new PassThrough();
        pt.write(Buffer.from(JSON.stringify(data)));
        pt.end();
        return pt;
    }

    async login() {
        if (this.tokenLease > Date.now()) {
            return;
        }

        if (this.loggingIn) {
            return;
        }
        this.loggingIn = true;
        this.console.log(`token expired at ${this.tokenLease}, renewing...`);

        const { parameters, leaseTimeSeconds } = await getLoginParameters(this.host, this.username, this.password, true);
        this.parameters = parameters;
        const now = Date.now();
        this.tokenLease = now + 1000 * leaseTimeSeconds;
        this.loggingIn = false;
        this.loggedIn = true;
        this.conmnectionTime = now;
    }

    async checkErrors() {
        if (this.rebooting) {
            return;
        }

        if (Date.now() - this.conmnectionTime > 1000 * 60 * 60 || this.loginFirstCount > 5) {
            this.console.log('Reconnecting')
            await this.reconnect();
        } else if (this.maxSessionsCount > 5) {
            await this.reboot();
        }
    }

    async requestWithLogin(options: HttpFetchOptions<Readable>, body?: Readable) {
        await this.login();
        if (!this.parameters) {
            return;
        }

        if (this.rebooting) {
            return;
        }

        const url = options.url as URL;
        const params = url.searchParams;
        for (const [k, v] of Object.entries(this.parameters)) {
            params.set(k, v);
        }
        const res = await this.request(options, body);
        const error = res?.body?.find(elem => elem.error)?.error;

        if (error) {
            const code = error.rspCode;
            if ([-6].includes(code)) {
                this.loginFirstCount++;
            } else if ([-5].includes(code)) {
                this.maxSessionsCount++;
            } else {
                this.maxSessionsCount = 0;
                this.loginFirstCount = 0;
            }
        }

        return res;
    }

    async reboot() {
        const url = new URL(`http://${this.host}/api.cgi`);
        const params = url.searchParams;
        params.set('cmd', 'Reboot');
        this.rebooting = true;
        const response = await this.requestWithLogin({
            url,
            responseType: 'json',
        });

        // Wait 1 minute, supposed to be ready
        setTimeout(() => {
            this.rebooting = false;
            this.maxSessionsCount = 0;
            this.loginFirstCount = 0;
        }, 1000 * 60);

        return {
            value: response?.body?.[0]?.value?.rspCode,
            data: response?.body,
        };
    }

    // [
    //     {
    //        "cmd" : "GetMdState",
    //        "code" : 0,
    //        "value" : {
    //           "state" : 0
    //        }
    //     }
    //  ]
    async getMotionState(channel: number) {
        const url = new URL(`http://${this.host}/api.cgi`);
        const params = url.searchParams;
        params.set('cmd', 'GetMdState');
        params.set('channel', String(channel));
        const response = await this.requestWithLogin({
            url,
            responseType: 'json',
        });
        return {
            value: !!response?.body?.[0]?.value?.state,
            data: response?.body,
        };
    }

    async logout() {
        const url = new URL(`http://${this.host}/api.cgi`);

        const body = [
            {
                cmd: "Logout",
            },
        ];

        await this.requestWithLogin({
            url,
            responseType: 'json',
            method: 'POST',
        }, this.createReadable(body));

        this.tokenLease = undefined;
        this.parameters = {};
    }

    async reconnect() {
        await this.logout();
        await this.login();
    }

    async getOsd(channel: number): Promise<Osd> {
        const url = new URL(`http://${this.host}/api.cgi`);

        const body = [
            {
                cmd: "GetOsd",
                action: 1,
                param: { channel: channel }
            },
        ];

        const response = await this.requestWithLogin({
            url,
            responseType: 'json',
            method: 'POST',
        }, this.createReadable(body));

        const error = response?.body?.find(elem => elem.error)?.error;
        if (error) {
            this.console.error('error during call to getOsd', error);
        }

        return response?.body?.[0] as Osd;
    }

    async setOsd(channel: number, osd: Osd) {
        const url = new URL(`http://${this.host}/api.cgi`);

        const body = [
            {
                cmd: "SetOsd",
                param: {
                    Osd: {
                        channel: channel,
                        osdChannel: osd.value.Osd.osdChannel,
                        osdTime: osd.value.Osd.osdTime,
                    }
                }
            }
        ];

        const response = await this.requestWithLogin({
            url,
            responseType: 'json',
            method: 'POST',
        }, this.createReadable(body));

        const error = response?.body?.find(elem => elem.error)?.error;
        if (error) {
            this.console.error('error during call to getOsd', error);
        }
    }

    async getAiState(channel: number) {
        const url = new URL(`http://${this.host}/api.cgi`);
        const params = url.searchParams;
        params.set('cmd', 'GetAiState');
        params.set('channel', String(channel));
        const response = await this.requestWithLogin({
            url,
            responseType: 'json',
        });
        return {
            value: (response?.body?.[0]?.value || response?.body?.value) as AIState,
            data: response?.body,
        };
    }

    async getAbility(channel: number) {
        const url = new URL(`http://${this.host}/api.cgi`);
        const params = url.searchParams;
        params.set('cmd', 'GetAbility');
        params.set('channel', String(channel));
        let response = await this.requestWithLogin({
            url,
            responseType: 'json',
        });
        let error = response?.body?.[0]?.error;
        if (error) {
            this.console.error('error during call to getAbility GET, Trying with POST', error);

            url.search = '';

            const body = [
                {
                    cmd: "GetAbility",
                    action: 0,
                    param: { User: { userName: this.username } }
                }
            ];

            response = await this.requestWithLogin({
                url,
                responseType: 'json',
                method: 'POST',
            }, this.createReadable(body));

            error = response?.body?.[0]?.error;
            if (error) {
                this.console.error('error during call to getAbility GET, Trying with POST', error);
                throw new Error('error during call to getAbility');
            }
        }

        return {
            value: response?.body?.[0]?.value || response?.body?.value,
            data: response?.body,
        };
    }

    async jpegSnapshot(channel: number, timeout = 10000) {
        const url = new URL(`http://${this.host}/cgi-bin/api.cgi`);
        const params = url.searchParams;
        params.set('cmd', 'Snap');
        params.set('channel', String(channel));
        params.set('rs', Date.now().toString());

        const response = await this.requestWithLogin({
            url,
            timeout,
        });

        return response?.body;
    }

    async getEncoderConfiguration(channel: number): Promise<Enc> {
        const url = new URL(`http://${this.host}/api.cgi`);
        const params = url.searchParams;
        params.set('cmd', 'GetEnc');
        params.set('channel', String(channel));
        const response = await this.requestWithLogin({
            url,
            responseType: 'json',
        });

        return response?.body?.[0]?.value?.Enc;
    }

    async getDeviceInfo(channel: number): Promise<DevInfo> {
        const url = new URL(`http://${this.host}/api.cgi`);
        const params = url.searchParams;
        params.set('cmd', 'GetDevInfo');
        const response = await this.requestWithLogin({
            url,
            responseType: 'json',
        });
        const error = response?.body?.[0]?.error;
        if (error) {
            this.console.error('error during call to getDeviceInfo', error);
            throw new Error('error during call to getDeviceInfo');
        }

        const deviceInfo: DevInfo = await response?.body?.[0]?.value?.DevInfo;

        // If the device is listed as homehub, fetch the channel specific information
        url.search = '';
        const body = [
            { cmd: "GetChnTypeInfo", action: 0, param: { channel: channel } },
            { cmd: "GetChannelstatus", action: 0, param: {} },
        ]

        const additionalInfoResponse = await this.requestWithLogin({
            url,
            method: 'POST',
            responseType: 'json'
        }, this.createReadable(body));

        const chnTypeInfo = additionalInfoResponse?.body?.find(elem => elem.cmd === 'GetChnTypeInfo');
        const chnStatus = additionalInfoResponse?.body?.find(elem => elem.cmd === 'GetChannelstatus');

        if (chnTypeInfo?.value) {
            deviceInfo.firmVer = chnTypeInfo.value.firmVer;
            deviceInfo.model = chnTypeInfo.value.typeInfo;
            deviceInfo.pakSuffix = chnTypeInfo.value.pakSuffix;
        }

        if (chnStatus?.value) {
            const specificChannelStatus = chnStatus.value?.status?.find(elem => elem.channel === channel);

            if (specificChannelStatus) {
                deviceInfo.name = specificChannelStatus.name;
            }
        }


        return deviceInfo;
    }

    async getPtzPresets(channel: number): Promise<PtzPreset[]> {
        const url = new URL(`http://${this.host}/api.cgi`);
        const params = url.searchParams;
        params.set('cmd', 'GetPtzPreset');
        const body = [
            {
                cmd: "GetPtzPreset",
                action: 1,
                param: {
                    channel
                }
            }
        ];
        const response = await this.requestWithLogin({
            url,
            responseType: 'json',
            method: 'POST'
        }, this.createReadable(body));
        return response?.body?.[0]?.value?.PtzPreset?.filter(preset => preset.enable === 1);
    }

    private async ptzOp(channel: number, op: string, speed: number, id?: number) {
        const url = new URL(`http://${this.host}/api.cgi`);
        const params = url.searchParams;
        params.set('cmd', 'PtzCtrl');

        const c1 = this.requestWithLogin({
            url,
            method: 'POST',
            responseType: 'text',
        }, this.createReadable([
            {
                cmd: "PtzCtrl",
                param: {
                    channel,
                    op,
                    speed,
                    timeout: 1,
                    id
                }
            },
        ]));

        await sleep(500);

        const c2 = this.requestWithLogin({
            url,
            method: 'POST',
        }, this.createReadable([
            {
                cmd: "PtzCtrl",
                param: {
                    channel,
                    op: "Stop"
                }
            },
        ]));

        this.console.log(await c1);
        this.console.log(await c2);
    }

    private async presetOp(channel: number, speed: number, id: number) {
        const url = new URL(`http://${this.host}/api.cgi`);
        const params = url.searchParams;
        params.set('cmd', 'PtzCtrl');

        const c1 = this.requestWithLogin({
            url,
            method: 'POST',
            responseType: 'text',
        }, this.createReadable([
            {
                cmd: "PtzCtrl",
                param: {
                    channel,
                    op: 'ToPos',
                    speed,
                    id
                }
            },
        ]));
    }

    async ptz(channel: number, command: PanTiltZoomCommand) {
        // reolink doesnt accept signed values to ptz
        // in favor of explicit direction.
        // so we need to convert the signed values to abs explicit direction.
        if (command.preset && !Number.isNaN(Number(command.preset))) {
            await this.presetOp(channel, 1, Number(command.preset));
            return;
        }

        let op = '';
        if (command.pan < 0)
            op += 'Left';
        else if (command.pan > 0)
            op += 'Right'
        if (command.tilt < 0)
            op += 'Down';
        else if (command.tilt > 0)
            op += 'Up';

        if (op) {
            await this.ptzOp(channel, op, Math.ceil(Math.abs(command?.pan || command?.tilt || 1) * 10));
        }

        op = undefined;
        if (command.zoom < 0)
            op = 'ZoomDec';
        else if (command.zoom > 0)
            op = 'ZoomInc';

        if (op) {
            await this.ptzOp(channel, op, Math.ceil(Math.abs(command?.zoom || 1) * 10));
        }
    }

    async getSiren(channel: number) {
        const url = new URL(`http://${this.host}/api.cgi`);

        const body = [{
            cmd: 'GetAudioAlarmV20',
            action: 0,
            param: { channel: channel }
        }];

        const response = await this.requestWithLogin({
            url,
            method: 'POST',
            responseType: 'json',
        }, this.createReadable(body));

        const error = response?.body?.[0]?.error;
        if (error) {
            this.console.error('error during call to getSiren', JSON.stringify(body), error);
        }

        return {
            enabled: response?.body?.[0]?.value?.Audio?.enable === 1
        };
    }

    async setSiren(channel: number, on: boolean, duration?: number) {
        const url = new URL(`http://${this.host}/api.cgi`);
        const params = url.searchParams;
        params.set('cmd', 'AudioAlarmPlay');

        let alarmMode;
        if (duration) {
            alarmMode = {
                alarm_mode: 'times',
                times: duration
            };
        }
        else {
            alarmMode = {
                alarm_mode: 'manul',
                manual_switch: on ? 1 : 0
            };
        }

        const response = await this.requestWithLogin({
            url,
            method: 'POST',
            responseType: 'json',
        }, this.createReadable([
            {
                cmd: "AudioAlarmPlay",
                action: 0,
                param: {
                    channel,
                    ...alarmMode
                }
            },
        ]));
        return {
            value: (response?.body?.[0]?.value || response?.body?.value) as SirenResponse,
            data: response?.body,
        };
    }

    async getWhiteLedState(channel: number) {
        const url = new URL(`http://${this.host}/api.cgi`);

        const body = [{
            cmd: 'GetWhiteLed',
            action: 0,
            param: { channel: channel }
        }];

        const response = await this.requestWithLogin({
            url,
            method: 'POST',
            responseType: 'json',
        }, this.createReadable(body));

        const error = response?.body?.[0]?.error;
        if (error) {
            this.console.error('error during call to getWhiteLedState', JSON.stringify(body), error);
        }

        return {
            enabled: response?.body?.[0]?.value?.WhiteLed?.state === 1
        };
    }

    async setWhiteLedState(channel: number, on?: boolean, brightness?: number) {
        const url = new URL(`http://${this.host}/api.cgi`);

        const settings: any = { channel: channel };

        if (on !== undefined) {
            settings.state = on ? 1 : 0;
        }

        if (brightness !== undefined) {
            settings.bright = brightness;
        }

        const body = [{
            cmd: 'SetWhiteLed',
            param: { WhiteLed: settings }
        }];

        const response = await this.requestWithLogin({
            url,
            method: 'POST',
            responseType: 'json',
        }, this.createReadable(body));

        const error = response?.body?.[0]?.error;
        if (error) {
            this.console.error('error during call to setWhiteLedState', JSON.stringify(body), error);
        }
    }

    async getBatteryInfo(channel: number) {
        const url = new URL(`http://${this.host}/api.cgi`);

        const body = [
            {
                cmd: "GetBatteryInfo",
                action: 0,
                param: { channel }
            },
            {
                cmd: "GetChannelstatus",
            }
        ];

        const response = await this.requestWithLogin({
            url,
            responseType: 'json',
            method: 'POST',
        }, this.createReadable(body));

        const error = response?.body?.find(elem => elem.error)?.error;
        if (error) {
            this.console.error('error during call to getBatteryInfo', error);
        }

        const batteryInfoEntry = response?.body.find(entry => entry.cmd === 'GetBatteryInfo')?.value?.Battery;
        const channelStatusEntry = response?.body.find(entry => entry.cmd === 'GetChannelstatus')?.value?.status
            ?.find(chStatus => chStatus.channel === channel)

        return {
            batteryPercent: batteryInfoEntry?.batteryPercent,
            sleeping: channelStatusEntry?.sleep === 1,
        }
    }

    async getEvents(channelsMap: Map<number, boolean>) {
        const url = new URL(`http://${this.host}/api.cgi`);

        const body = [];

        channelsMap.forEach((isBattery, channel) => {
            if (isBattery) {
                body.push({
                    cmd: 'GetEvents',
                    action: 0,
                    param: { channel }
                });
            } else {
                body.push({
                    cmd: 'GetMdState',
                    action: 0,
                    param: { channel }
                });
                body.push({
                    cmd: 'GetAiState',
                    action: 0,
                    param: { channel }
                });
            }
        })

        const response = await this.requestWithLogin({
            url,
            responseType: 'json',
            method: 'POST',
        }, this.createReadable(body));

        if (!response) {
            return {};
        }

        const ret: Record<number, { motion: boolean, objects: string[] }> = {};

        const processDetections = (aiResponse: any) => {
            const classes: string[] = [];
            for (const key of Object.keys(aiResponse ?? {})) {
                if (key === 'channel')
                    continue;
                const { support, alarm_state } = aiResponse[key];
                if (alarm_state)
                    classes.push(key);
            }

            return classes;
        }

        for (const item of response.body) {
            const channel = item?.value?.channel;
            const cmd = item?.cmd;
            const numericChannel = Number(channel);

            if (!ret[numericChannel]) {
                ret[numericChannel] = { motion: false, objects: [] };
            }

            const elem = ret[numericChannel];

            if (cmd === 'GetEvents') {
                const classes = processDetections(item.value?.ai);
                elem.motion = classes.includes('other');
                elem.objects = classes.filter(cl => cl !== 'other');
            } else if (cmd === 'GetMdState') {
                elem.motion = item?.value?.state;
            } else if (cmd === 'GetAiState') {
                const classes = processDetections(item.value?.ai);
                elem.objects = classes;
            }
        }

        const error = response?.body?.find(elem => elem.error)?.error;
        if (error) {
            this.console.error('error during call to getEvents', error);
        }

        return {
            parsed: ret,
            response: response.body,
            body: response.body
        };
    }

    async getPirState(channel: number) {
        const url = new URL(`http://${this.host}/api.cgi`);

        const body = [{
            cmd: 'GetPirInfo',
            action: 0,
            param: { channel: channel }
        }];

        const response = await this.requestWithLogin({
            url,
            method: 'POST',
            responseType: 'json',
        }, this.createReadable(body));

        const error = response?.body?.[0]?.error;
        if (error) {
            this.console.error('error during call to getPirState', JSON.stringify(body), error);
        }

        return {
            enabled: response?.body?.[0]?.value?.pirInfo?.enable === 1,
            state: response?.body?.[0]?.value?.pirInfo
        };
    }

    async setPirState(channel: number, on: boolean) {
        const url = new URL(`http://${this.host}/api.cgi`);

        const currentPir = await this.getPirState(channel);
        const newState = on ? 1 : 0;

        if (!currentPir || currentPir.state?.enable === newState) {
            return;
        }

        const pirInfo = {
            ...currentPir,
            channel: channel,
            enable: newState
        }

        const body = [{
            cmd: 'SetPirInfo',
            action: 0,
            param: { pirInfo }
        }];

        const response = await this.requestWithLogin({
            url,
            method: 'POST',
            responseType: 'json',
        }, this.createReadable(body));

        const error = response?.body?.[0]?.error;
        if (error) {
            this.console.error('error during call to setPirState', JSON.stringify(body), error);
        }
    }

    async getLocalLink(channel: number) {
        const url = new URL(`http://${this.host}/api.cgi`);

        const body = [
            {
                cmd: 'GetLocalLink',
                action: 0,
                param: {}
            },
            {
                cmd: 'GetWifiSignal',
                action: 0,
                param: { channel: channel }
            },
        ];

        const response = await this.requestWithLogin({
            url,
            method: 'POST',
            responseType: 'json',
        }, this.createReadable(body));

        const error = response?.body?.[0]?.error;
        if (error) {
            this.console.error('error during call to getLocalLink', JSON.stringify(body), error);
        }

        const activeLink = response?.body?.find(entry => entry.cmd === 'GetLocalLink')
            ?.value?.LocalLink?.activeLink;
        const wifiSignal = response?.body?.find(entry => entry.cmd === 'GetWifiSignal')
            ?.value?.wifiSignal ?? undefined

        let isWifi = false;
        if (wifiSignal !== undefined) {
            isWifi = wifiSignal >= 0 && wifiSignal <= 4;
        }

        if (!isWifi && activeLink) {
            isWifi = activeLink !== 'LAN';
        }

        return {
            activeLink,
            wifiSignal,
            isWifi
        };
    }

    async getVideoClips(
        channel: number,
        options?: VideoClipOptions,
        streamType: VideoSearchType = 'main',
    ) {
        const url = new URL(`http://${this.host}/api.cgi`);

        const startTime = new Date(options.startTime);
        let endTime = options.endTime ? new Date(options.endTime) : undefined;

        // If the endTime is not the same day as startTime, 
        // or no endDate is provided, set to the end of the startTime
        // Reolink only supports 1 day recordings fetching
        if (!endTime || endTime.getDate() > startTime.getDate()) {
            endTime = new Date(startTime);
            endTime.setHours(23);
            endTime.setMinutes(59);
            endTime.setSeconds(59);
        }

        const body = [
            {
                cmd: "Search",
                action: 1,
                param: {
                    Search: {
                        channel,
                        streamType,
                        onlyStatus: 0,
                        StartTime: {
                            year: startTime.getFullYear(),
                            mon: startTime.getMonth() + 1,
                            day: startTime.getDate(),
                            hour: startTime.getHours(),
                            min: startTime.getMinutes(),
                            sec: startTime.getSeconds()
                        },
                        EndTime: {
                            year: endTime.getFullYear(),
                            mon: endTime.getMonth() + 1,
                            day: endTime.getDate(),
                            hour: endTime.getHours(),
                            min: endTime.getMinutes(),
                            sec: endTime.getSeconds()
                        }
                    }
                }
            }
        ];

        try {
            const response = await this.requestWithLogin({
                url,
                responseType: 'json',
                method: 'POST',
            }, this.createReadable(body));

            const error = response?.body?.[0]?.error;
            if (error) {
                this.console.log('Error fetching videoclips', error, JSON.stringify({ body, url }));
                return [];
            }

            return (response?.body?.[0]?.value?.SearchResult?.File ?? []) as VideoSearchResult[];
        } catch (e) {
            this.console.log('Error fetching videoclips', e);
            return [];
        }
    }

    async getVideoClipUrl(videoclipPath: string, channel: number) {
        const fileNameWithExtension = videoclipPath.split('/').pop();
        // const fileName = fileNameWithExtension.split('.').shift();
        let sanitizedPath = videoclipPath.replaceAll(' ', '%20');
        if (!sanitizedPath.startsWith('/')) {
            sanitizedPath = `/${sanitizedPath}`;
        }

        const match = fileNameWithExtension.match(/.*Rec(\w{3})(?:_|_DST)(\d{8})_(\d{6})_.*/);
        const date = match[2];
        const time = match[3];
        const start = `${date}${time}`;
        const playbackPath = `cgi-bin/api.cgi?cmd=Playback&channel=${channel}&source=${sanitizedPath}&start=${start}&type=0&seek=0&token=${this.parameters.token}`;
        const downloadPath = `cgi-bin/api.cgi?cmd=Download&source=${sanitizedPath}&output=ha_playback_${start}.mp4&start=${start}&token=${this.parameters.token}`;

        return {
            // playbackPathWithHost: `http://${this.host}/${playbackPath}`,
            downloadPathWithHost: `http://${this.host}/${downloadPath}`,
        };
    }
}
