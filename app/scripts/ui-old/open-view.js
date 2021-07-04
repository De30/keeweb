import * as kdbxweb from 'kdbxweb';
import { View } from 'framework/views/view';
import { Events } from 'framework/events';
import { Storage } from 'storage';
import { Alerts } from 'comp/ui/alerts';
import { UsbListener } from 'comp/app/usb-listener';
import { YubiKey } from 'comp/app/yubikey';
import { UrlFormat } from 'util/formatting/url-format';
import { Locale } from 'util/locale';
import { Logger } from 'util/logger';
import { OpenConfigView } from 'views/open-config-view';
import { OpenChalRespView } from 'views/open-chal-resp-view';
import { omit } from 'util/fn';
import { NativeModules } from 'comp/launcher/native-modules';

const logger = new Logger('open-view');

class OpenView extends View {
    windowFocused() {
        this.inputEl.focus();
        this.checkIfEncryptedPasswordDateIsValid();
    }

    displayOpenChalResp() {
        this.$el
            .find('.open__settings-yubikey')
            .toggleClass('open__settings-yubikey--active', !!this.params.chalResp);
    }

    displayOpenDeviceOwnerAuth() {
        const available = !!this.encryptedPassword;
        const passEmpty = !this.passwordInput.length;
        const canUseEncryptedPassword = available && passEmpty;
        this.el
            .querySelector('.open__pass-enter-btn')
            .classList.toggle('open__pass-enter-btn--touch-id', canUseEncryptedPassword);
    }

    openDb() {
        if (this.encryptedPassword && !this.params.password.length) {
            logger.info('Encrypting password using hardware decryption');
            const touchIdPrompt = Locale.bioOpenAuthPrompt.replace('{}', this.params.name);
            const encryptedPassword = kdbxweb.ProtectedValue.fromBase64(
                this.encryptedPassword.value
            );
            Events.emit('hardware-decrypt-started');
            NativeModules.hardwareDecrypt(encryptedPassword, touchIdPrompt)
                .then((password) => {
                    Events.emit('hardware-decrypt-finished');

                    this.params.password = password;
                    this.params.encryptedPassword = this.encryptedPassword;
                    this.model.openFile(this.params, (err) => this.openDbComplete(err));
                })
                .catch((err) => {
                    Events.emit('hardware-decrypt-finished');

                    if (err.message.includes('User refused')) {
                        err.userCanceled = true;
                    } else if (err.message.includes('SecKeyCreateDecryptedData')) {
                        err.maybeTouchIdChanged = true;
                    }
                    logger.error('Error in hardware decryption', err);
                    this.openDbComplete(err);
                });
        } else {
            this.params.encryptedPassword = null;
        }
    }

    showConfig(storage) {
        if (this.busy) {
            return;
        }
        if (this.views.openConfig) {
            this.views.openConfig.remove();
        }
        const config = {
            id: storage.name,
            name: Locale[storage.name] || storage.name,
            icon: storage.icon,
            buttons: true,
            ...storage.getOpenConfig()
        };
        this.views.openConfig = new OpenConfigView(config, {
            parent: '.open__config-wrap'
        });
        this.views.openConfig.on('cancel', this.closeConfig.bind(this));
        this.views.openConfig.on('apply', this.applyConfig.bind(this));
        this.views.openConfig.render();
        this.$el.find('.open__pass-area').addClass('hide');
        this.$el.find('.open__icons--lower').addClass('hide');
    }

    closeConfig() {
        if (this.busy) {
            this.storageWaitId = null;
            this.busy = false;
        }
        if (this.views.openConfig) {
            this.views.openConfig.remove();
            delete this.views.openConfig;
        }
        this.$el.find('.open__pass-area').removeClass('hide');
        this.$el.find('.open__config').addClass('hide');
        this.focusInput();
    }

    applyConfig(config) {
        if (this.busy || !config) {
            return;
        }
        this.busy = true;
        this.views.openConfig.setDisabled(true);
        const storage = Storage[config.storage];
        this.storageWaitId = Math.random();
        const path = config.path;
        const opts = omit(config, ['path', 'storage']);
        const req = {
            waitId: this.storageWaitId,
            storage: config.storage,
            path,
            opts
        };
        if (storage.applyConfig) {
            storage.applyConfig(opts, this.storageApplyConfigComplete.bind(this, req));
        } else {
            storage.stat(path, opts, this.storageStatComplete.bind(this, req));
        }
    }

    storageApplyConfigComplete(req, err) {
        if (this.storageWaitId !== req.waitId) {
            return;
        }
        this.storageWaitId = null;
        this.busy = false;
        if (err) {
            this.views.openConfig.setDisabled(false);
            this.views.openConfig.setError(err);
        } else {
            this.closeConfig();
        }
    }

    storageStatComplete(req, err, stat) {
        if (this.storageWaitId !== req.waitId) {
            return;
        }
        this.storageWaitId = null;
        this.busy = false;
        if (err) {
            this.views.openConfig.setDisabled(false);
            this.views.openConfig.setError(err);
        } else {
            this.closeConfig();
            this.params.id = null;
            this.params.storage = req.storage;
            this.params.path = req.path;
            this.params.opts = req.opts;
            this.params.name = UrlFormat.getDataFileName(req.path);
            this.params.rev = stat.rev;
            this.params.fileData = null;
            this.encryptedPassword = null;
            this.displayOpenFile();
            this.displayOpenDeviceOwnerAuth();
        }
    }

    usbDevicesChanged() {
        if (this.model.settings.canOpenOtpDevice) {
            const hasYubiKeys = !!UsbListener.attachedYubiKeys;

            const showOpenIcon = hasYubiKeys && this.model.settings.yubiKeyShowIcon;
            this.$el.find('.open__icon-yubikey').toggleClass('hide', !showOpenIcon);

            const showChallengeResponseIcon =
                hasYubiKeys && this.model.settings.yubiKeyShowChalResp;
            this.$el
                .find('.open__settings-yubikey')
                .toggleClass('open__settings-yubikey--present', !!showChallengeResponseIcon);

            if (!hasYubiKeys && this.busy && this.otpDevice) {
                this.otpDevice.cancelOpen();
            }
        }
    }

    openYubiKey() {
        if (this.busy && this.otpDevice) {
            this.otpDevice.cancelOpen();
        }
        if (!this.busy) {
            this.busy = true;
            this.inputEl.attr('disabled', 'disabled');
            const icon = this.$el.find('.open__icon-yubikey');
            icon.toggleClass('flip3d', true);

            YubiKey.checkToolStatus().then((status) => {
                if (status !== 'ok') {
                    icon.toggleClass('flip3d', false);
                    this.inputEl.removeAttr('disabled');
                    this.busy = false;
                    return Events.emit('toggle-settings', 'devices');
                }
                this.otpDevice = this.model.openOtpDevice((err) => {
                    if (err && !YubiKey.aborted) {
                        Alerts.error({
                            header: Locale.openError,
                            body: Locale.openErrorDescription,
                            pre: this.errorToString(err)
                        });
                    }
                    this.otpDevice = null;
                    icon.toggleClass('flip3d', false);
                    this.inputEl.removeAttr('disabled');
                    this.busy = false;
                });
            });
        }
    }

    selectYubiKeyChalResp() {
        if (this.busy) {
            return;
        }

        if (this.params.chalResp) {
            this.params.chalResp = null;
            this.el
                .querySelector('.open__settings-yubikey')
                .classList.remove('open__settings-yubikey--active');
            this.focusInput();
            return;
        }

        const chalRespView = new OpenChalRespView();
        chalRespView.on('select', ({ vid, pid, serial, slot }) => {
            this.params.chalResp = { vid, pid, serial, slot };
            this.el
                .querySelector('.open__settings-yubikey')
                .classList.add('open__settings-yubikey--active');
            this.focusInput();
        });

        Alerts.alert({
            header: Locale.openChalRespHeader,
            icon: 'usb-token',
            buttons: [{ result: '', title: Locale.alertCancel }],
            esc: '',
            click: '',
            view: chalRespView
        });
    }

    errorToString(err) {
        const str = err.toString();
        if (str !== {}.toString()) {
            return str;
        }
        if (err.ykError && err.code) {
            return Locale.yubiKeyErrorWithCode.replace('{}', err.code);
        }
        return undefined;
    }

    setEncryptedPassword(fileInfo) {
        this.encryptedPassword = null;
        if (!fileInfo.id) {
            return;
        }
        switch (this.model.settings.deviceOwnerAuth) {
            case 'memory':
                this.encryptedPassword = this.model.getMemoryPassword(fileInfo.id);
                break;
            case 'file':
                this.encryptedPassword = {
                    value: fileInfo.encryptedPassword,
                    date: fileInfo.encryptedPasswordDate
                };
                break;
        }
        this.checkIfEncryptedPasswordDateIsValid();
    }

    checkIfEncryptedPasswordDateIsValid() {
        if (this.encryptedPassword) {
            const maxDate = new Date(this.encryptedPassword.date);
            maxDate.setMinutes(
                maxDate.getMinutes() + this.model.settings.deviceOwnerAuthTimeoutMinutes
            );
            if (maxDate < new Date()) {
                this.encryptedPassword = null;
            }
        }
    }

    openMessageCancelClick() {
        this.model.rejectPendingFileUnlockPromise('User canceled');
    }
}

export { OpenView };