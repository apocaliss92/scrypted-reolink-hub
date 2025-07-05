import { MixinProvider, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, SettingValue, WritableDeviceState } from "@scrypted/sdk";
import { StorageSettings, StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import { getBaseLogger } from '../../scrypted-apocaliss-base/src/basePlugin';
import FrigateBridgePlugin, { pluginId, REOLINK_HUB_VIDEOCLIPS_INTERFACE } from "./main";
import ReolinkVideoclipssMixins from "./videoclipsMixin";

export default class ReolinkVideoclips extends ScryptedDeviceBase implements MixinProvider {
    initStorage: StorageSettingsDict<string> = {
    };
    storageSettings = new StorageSettings(this, this.initStorage);
    currentMixinsMap: Record<string, ReolinkVideoclipssMixins> = {};
    plugin: FrigateBridgePlugin;

    constructor(nativeId: string, plugin: FrigateBridgePlugin) {
        super(nativeId);
        this.plugin = plugin;
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

