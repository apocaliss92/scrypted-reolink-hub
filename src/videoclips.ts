import { sleep } from "@scrypted/common/src/sleep";
import sdk, { MixinProvider, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, SettingValue, WritableDeviceState } from "@scrypted/sdk";
import { StorageSettings, StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import fs from 'fs';
import { getBaseLogger } from '../../scrypted-apocaliss-base/src/basePlugin';
import ReolinkProvider, { pluginId, REOLINK_HUB_VIDEOCLIPS_INTERFACE } from "./main";
import ReolinkVideoclipssMixins from "./videoclipsMixin";

export default class ReolinkVideoclips extends ScryptedDeviceBase implements MixinProvider {
    initStorage: StorageSettingsDict<string> = {
    };
    storageSettings = new StorageSettings(this, this.initStorage);
    currentMixinsMap: Record<string, ReolinkVideoclipssMixins> = {};
    plugin: ReolinkProvider;
    ffmpegPath: string;
    thumbnailsToGenerate: { deviceId: string, thumbnailId: string }[] = [];
    generatingThumbnails = false;

    constructor(nativeId: string, plugin: ReolinkProvider) {
        super(nativeId);
        this.plugin = plugin;
        const logger = this.getLogger();
        this.init().catch(logger.error);
    }

    async init() {
        this.ffmpegPath = await sdk.mediaManager.getFFmpegPath();

        setInterval(async () => {
            if (!this.generatingThumbnails) {
                const item = this.thumbnailsToGenerate.shift();
                if (item) {
                    const { deviceId, thumbnailId } = item;
                    const deviceMixin = this.currentMixinsMap[deviceId];
                    const deviceLogger = deviceMixin.getLogger();
                    deviceLogger.log(`Generating thumbnail of clip ${thumbnailId}`);
                    this.generatingThumbnails = true;

                    const { videoclipUrl, thumbnailUrl } = await deviceMixin.getVideoclipParams(thumbnailId);

                    try {
                        const jpeg = await deviceMixin.generateThumbnail(videoclipUrl);
                        if (jpeg.length) {
                            deviceLogger.log(`Saving thumbnail in ${thumbnailUrl}`);
                            await fs.promises.writeFile(thumbnailUrl, jpeg);
                        } else {
                            deviceLogger.log('Not saving, image is corrupted');
                        }
                    } catch (e) {
                        deviceLogger.log('Failed generating thumbnail', videoclipUrl, thumbnailId, e);
                    } finally {
                        this.generatingThumbnails = false;
                        await sleep(3000);
                    }
                }
            }
        }, 1000);
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        return this.storageSettings.putSetting(key, value);
    }

    public getLogger() {
        return getBaseLogger({
            console: this.console,
            storage: this.storageSettings,
        });
    }

    async getSettings() {
        try {
            const settings = await this.storageSettings.getSettings();
            return settings;
        } catch (e) {
            this.getLogger().log('Error in getSettings', e);
            return [];
        }
    }

    async canMixin(type: ScryptedDeviceType, interfaces: string[]): Promise<string[]> {
        return [
            ScryptedInterface.Camera,
            ScryptedInterface.VideoCamera,
        ].some(int => interfaces.includes(int)) &&
            interfaces.includes(pluginId) ?
            [
                ScryptedInterface.Settings,
                ScryptedInterface.VideoClips,
                REOLINK_HUB_VIDEOCLIPS_INTERFACE
            ] :
            undefined;
    }

    async getMixin(mixinDevice: any, mixinDeviceInterfaces: ScryptedInterface[], mixinDeviceState: WritableDeviceState): Promise<any> {
        return new ReolinkVideoclipssMixins({
            mixinDevice,
            mixinDeviceInterfaces,
            mixinDeviceState,
            mixinProviderNativeId: this.nativeId,
            group: 'Reolink HUB videoclips',
            groupKey: 'reolinkHubVideoclips',
        }, this)
    }

    async releaseMixin(id: string, mixinDevice: any): Promise<void> {
        await mixinDevice.release();
    }
}

