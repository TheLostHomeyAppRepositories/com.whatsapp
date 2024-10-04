const Homey = require('homey');
const { parsePhoneNumber } = require('libphonenumber-js');
const { validateUrl, sleep, getBase64Image } = require('../../lib/helpers');

module.exports = class Whatsapp extends Homey.Device {
    async onInit() {
        try {
            this.homey.app.log('[Device] - init =>', this.getName());
            this.setUnavailable(`Connecting to WhatsApp`);

            this.cleanupWidgetStore();

            await this.synchronousStart();

            await this.checkCapabilities();
            await this.setTriggers();
            await this.setConditions();
            await this.setWhatsappClient();
        } catch (error) {
            this.homey.app.log(`[Device] ${this.getName()} - OnInit Error`, error);
        }
    }

    async onAdded() {
        await this.syncTempDbToStore();

        if (this.driver.onReadyInterval) {
            this.homey.clearInterval(this.driver.onReadyInterval);
        }
    }

    async onDeleted() {
        await this.removeWhatsappClient();
    }

    async setTriggers() {
        this.new_message = this.homey.flow.getDeviceTriggerCard('new_message');
        this.new_image = this.homey.flow.getDeviceTriggerCard('new_image');
    }

    async setConditions() {
        const text_condition = this.homey.flow.getConditionCard('text_condition');
        text_condition.registerRunListener(async (args, state) => {
            this.homey.app.log('[text_condition]', { ...args, device: 'LOG' });

            const result = state.text && state.text.toLowerCase() === args.text_input.toLowerCase();

            this.homey.app.log('[text_condition] - result: ', result);
            return result;
        });

        const text_contains_condition = this.homey.flow.getConditionCard('text_contains_condition');
        text_contains_condition.registerRunListener(async (args, state) => {
            this.homey.app.log('[text_contains_condition]', { ...args, device: 'LOG' });

            const result = state.text && state.text.toLowerCase().includes(args.text_input.toLowerCase());

            this.homey.app.log('[text_contains_condition] - result: ', result);
            return result;
        });

        const from_condition = this.homey.flow.getConditionCard('from_condition');
        from_condition.registerRunListener(async (args, state) => {
            this.homey.app.log('[from_condition]', { ...args, device: 'LOG' });
            const result = state.from && state.from.toLowerCase() === args.from_input.toLowerCase();

            this.homey.app.log('[from_condition] - result: ', result);
            return result;
        });

        const from_number_condition = this.homey.flow.getConditionCard('from_number_condition');
        from_number_condition.registerRunListener(async (args, state) => {
            this.homey.app.log('[from_number_condition]', { ...args, device: 'LOG' });
            const result = state.fromNumber && state.fromNumber.toLowerCase() === args.from_input.toLowerCase();

            this.homey.app.log('[from_number_condition] - result: ', result);
            return result;
        });

        const group_condition = this.homey.flow.getConditionCard('group_condition');
        group_condition.registerRunListener(async (args, state) => {
            this.homey.app.log('[group_condition]', { ...args, device: 'LOG' });
            const result = state.group === true;

            this.homey.app.log('[group_condition] - result: ', result);
            return result;
        });

        const image_condition = this.homey.flow.getConditionCard('image_condition');
        image_condition.registerRunListener(async (args, state) => {
            this.homey.app.log('[image_condition]', { ...args, device: 'LOG' });
            const result = state.hasImage === true;

            this.homey.app.log('[image_condition] - result: ', result);
            return result;
        });
    }

    async synchronousStart() {
        const driverData = this.driver;
        const driverDevices = driverData.getDevices();
        const deviceObject = this.getData();

        const sleepIndex = driverDevices.findIndex((device) => {
            const driverDeviceObject = device.getData();
            return deviceObject.id === driverDeviceObject.id;
        });

        await sleep(sleepIndex * 7500);

        this.homey.app.log('[Device] - init - after sleep =>', sleepIndex, this.getName());
    }

    async syncTempDbToStore() {
        const deviceObject = this.getData();
        const clientId = deviceObject.id.split('_')[1];
        if (this.driver.tempDB[clientId]) {
            this.homey.app.log(`[Device] - ${this.getName()} => syncTempDbToStore - found tempDB - syncing with store`);
            for (let i = 0; i < Object.keys(this.driver.tempDB[clientId]).length; i++) {
                const key = Object.keys(this.driver.tempDB[clientId])[i];
                const value = this.driver.tempDB[clientId][key];

                await this.setStoreValue(key, value);
            }

            this.driver.tempDB = {};
            this.homey.app.log(`[Device] - ${this.getName()} => syncTempDbToStore - tempDB cleared`, this.driver.tempDB);
        }
    }

    // ------------- API -------------
    async setWhatsappClient() {
        try {
            const deviceObject = this.getData();
            this.homey.app.log(`[Device] - ${this.getName()} => setWhatsappClient`);

            this.WhatsappClient = this.driver.WhatsappClients[deviceObject.id];

            const result = await this.WhatsappClient.startup();

            if (result) {
                this.setAvailable();
            } else {
                this.setUnavailable('New paring code is needed. Please try to repair the device.');
            }
        } catch (error) {
            this.homey.app.log(`[Device] ${this.getName()} - setWhatsappClient - error =>`, error);
        }
    }

    async removeWhatsappClient() {
        if (this.WhatsappClient) {
            this.WhatsappClient.deleteDevice();
            this.WhatsappClient = null;
        }
    }

    async onCapability_SendMessage(params, type) {
        this.homey.app.log(`[Device] ${this.getName()} - onCapability_SendMessage`);

        const message = params.message && params.message.length ? params.message : '‎';

        const isGroup = validateUrl(params.recipient);
        const recipient = await this.getRecipient(params.recipient, isGroup);

        if (recipient) {
            const data = await this.sendMessage(recipient, message, type, params, isGroup);

            this.homey.app.log(`[Device] ${this.getName()} - onCapability_SendMessage`, Object.keys(data).length);

            return !!Object.keys(data).length;
        }

        return false;
    }

    async getRecipient(recipient, isGroup) {
        if (recipient.includes('@g.us') || recipient.includes('@s.whatsapp.net') || recipient.includes('@newsletter')) {
            return recipient;
        }

        if (!isGroup) {
            const phoneNumber = parsePhoneNumber(recipient);
            if (!phoneNumber.isValid()) {
                throw new Error('Invalid mobile number (Make sure to include the country code (e.g. +31))');
            }

            recipient = phoneNumber.number;
            recipient = recipient.replace('+', '');
            recipient = recipient.replace(' ', '');
            recipient = `${recipient}@s.whatsapp.net`;
        } else if (isGroup) {
            recipient = recipient.replace(' ', '');
            recipient = recipient.replace(' ', '');
            recipient = recipient.replace(' ', '');

            const groupJid = recipient.replace(' ', '').split('/').pop();
            this.homey.app.log(`[Device] ${this.getName()} - getRecipient - fetching group JID`, groupJid);

            recipient = (await this.getStoreValue(groupJid)) || null;
            this.homey.app.log(`[Device] ${this.getName()} - getRecipient - fetching group JID from store: `, recipient);

            if (!recipient) {
                recipient = (await this.WhatsappClient.getGroupWithInvite(groupJid)) || null;
                this.homey.app.log(`[Device] ${this.getName()} - getRecipient - fetching group JID from WhatsappClient`, recipient);

                if (recipient) {
                    recipient = recipient.id;

                    await this.setStoreValue(groupJid, recipient);
                    this.homey.app.log(`[Device] ${this.getName()} - getRecipient - saved group JID to Store`, recipient);
                } else {
                    throw new Error('Could not get group ID. Is the group link correct?');
                }
            }
        }

        return recipient;
    }

    async sendMessage(recipient, message, msgType, params = null, isGroup = false) {
        let data = {};

        if (recipient && message && !msgType) {
            this.homey.app.log(`[Device] ${this.getName()} - sendMessage - sendText`, { recipient, message, msgType });

            this.sendToWidget({
                jid: recipient,
                from: '',
                fromMe: true,
                timeStamp: Date.now(),
                text: message,
                group: isGroup,
                hasImage: false,
                imageUrl: null,
                base64Image: null
            });

            data = await this.WhatsappClient.sendText(recipient, message);
        } else if (recipient && msgType) {
            let fileUrl = params.droptoken || params.file || null;

            if (!!fileUrl && !!fileUrl.localUrl) {
                fileUrl = fileUrl.localUrl;
            }

            this.sendToWidget({
                jid: recipient,
                from: '',
                fromMe: true,
                timeStamp: Date.now(),
                text: message,
                group: isGroup,
                hasImage: msgType === 'image',
                imageUrl: fileUrl,
                base64Image: null
            });

            this.homey.app.log(`[Device] ${this.getName()} - sendMessage - send${msgType}`, { ...params, recipient, message, fileUrl, msgType, device: 'LOG' });

            if (msgType === 'video' || msgType === 'image') {
                data = await this.WhatsappClient.sendMedia(recipient, fileUrl, message, msgType);
            } else if (msgType === 'audio') {
                throw new Error('Audio is not supported yet');
            } else if (msgType === 'document') {
                data = await this.WhatsappClient.sendFile(recipient, fileUrl);
            } else if (msgType === 'location') {
                const { lat } = params;

                const splittedParam = lat.split(',');

                if (splittedParam.length > 1) {
                    data = await this.WhatsappClient.sendLocation(recipient, splittedParam[0], splittedParam[1], message);
                } else {
                    throw new Error('Invalid location, use comma separated Latitude,Longitude');
                }
            }
        }

        return data || true;
    }

    async coolDown() {
        return await sleep(1000);
    }

    // ------------- Triggers -------------

    async messageHelper(msg) {
        try {
            const settings = await this.getSettings();

            msg.messages.forEach(async (m) => {
                console.log(m);

                let newDate = new Date();
                newDate.setTime(m.messageTimestamp * 1000);
                let dateString = newDate.toUTCString();

                const group = m.key && m.key.participant ? true : false;
                const from = m.pushName;
                const fromJid = group ? m.key.participant : m.key && m.key.remoteJid;
                const fromNumber = `+${fromJid.split('@')[0]}`;
                const jid = m.key && m.key.remoteJid;
                const fromMe = m.key && m.key.fromMe;
                const triggerAllowed = (fromMe && settings.trigger_own_message) || !fromMe;
                const hasImage = m.message && m.message.imageMessage ? true : false;
                const imageBuffer = hasImage ? await this.WhatsappClient.downloadMediaMsg(m) : null;
                const base64Image = imageBuffer ? imageBuffer.toString('base64') : null;

                console.log(imageBuffer);

                let text = m.message && m.message.conversation;

                if (!text) {
                    text = (m.message && m.message.extendedTextMessage && m.message.extendedTextMessage.text) || '';
                }

                if (hasImage) {
                    text = (m.message && m.message.imageMessage && m.message.imageMessage.caption) || '';
                }

                const tokens = { replyTo: jid, fromNumber, from, text, time: dateString, group, hasImage };
                const state = tokens;

                console.log('tokens', tokens);

                triggerAllowed && this.new_message.trigger(this, tokens, state);

                this.sendToWidget({ jid, from: from, fromMe, timeStamp: m.messageTimestamp * 1000, text, group, hasImage, imgUrl: null, base64Image: `data:image/jpeg;base64,${base64Image}` });
            });

            return true;
        } catch (error) {
            console.log('Error in message', error);
        }
    }

    // ------------- Capabilities -------------
    async checkCapabilities() {
        const driverManifest = this.driver.manifest;
        let driverCapabilities = driverManifest.capabilities;

        const deviceCapabilities = this.getCapabilities();

        this.homey.app.log(`[Device] ${this.getName()} - Found capabilities =>`, deviceCapabilities);
        this.homey.app.log(`[Device] ${this.getName()} - Driver capabilities =>`, driverCapabilities);

        await this.updateCapabilities(driverCapabilities, deviceCapabilities);

        return true;
    }

    async updateCapabilities(driverCapabilities, deviceCapabilities) {
        try {
            const newC = driverCapabilities.filter((d) => !deviceCapabilities.includes(d));
            const oldC = deviceCapabilities.filter((d) => !driverCapabilities.includes(d));

            if (oldC.length) {
                this.homey.app.log(`[Device] ${this.getName()} - Got old capabilities =>`, oldC);

                oldC.forEach((c) => {
                    this.homey.app.log(`[Device] ${this.getName()} - updateCapabilities => Remove `, c);
                    this.removeCapability(c);
                });

                await sleep(2000);
            }

            if (newC.length) {
                this.homey.app.log(`[Device] ${this.getName()} - Got new capabilities =>`, newC);

                newC.forEach((c) => {
                    this.homey.app.log(`[Device] ${this.getName()} - updateCapabilities => Add `, c);
                    this.addCapability(c);
                });
                await sleep(2000);
            }
        } catch (error) {
            this.homey.app.log(error);
        }
    }

    async sendToWidget(data) {
        const widgetJids = await this.getWidgetJids();
        let chat = this.getStoreValue(`widget-chat-${data.jid}`);

        if (data.imageUrl) {
            const base64Image = await getBase64Image(data.imageUrl);
            data.base64Image = `data:image/jpeg;base64,${base64Image}`;
        }

        if (chat) {
            let parsedChat = JSON.parse(chat);
            if (parsedChat.length > 20) {
                parsedChat = parsedChat.slice(parsedChat.length - 20);
            }

            this.setStoreValue(`widget-chat-${data.jid}`, JSON.stringify([...parsedChat, data]));
        } else if (widgetJids.includes(data.jid)) {
            this.setStoreValue(`widget-chat-${data.jid}`, JSON.stringify([]));
        }

        this.homey.api.realtime('chat', data);
    }

    async getWidgetJids(updateKeys = false) {
        const widgetJids = [];
        const storeData = this.getStore();

        for await(const [storeKey, storeValue] of Object.entries(storeData)) {
            if (storeKey.startsWith('widget-instance-') || storeValue.endsWith('@s.whatsapp.net') || storeValue.endsWith('@g.us')) {
                if (!widgetJids.includes(storeValue)) {
                    this.homey.app.log(`[Device] ${this.getName()} - getWidgetJids - found jid`, storeValue);
                    widgetJids.push(storeValue);
                }

                if (updateKeys && !storeKey.startsWith('widget-instance-') && storeKey.length === 36) {
                    this.homey.app.log(`[Device] ${this.getName()} - getWidgetJids - update storekey ${storeKey} to widget-instance-${storeKey} for value`, storeValue);
                    this.setStoreValue(`widget-instance-${storeKey}`, storeValue);
                    this.unsetStoreValue(storeKey);
                }
            }
        }

        this.homey.app.log(`[Device] ${this.getName()} - getWidgetJids - found widgetJids`, widgetJids);

        return widgetJids;
    }

    async cleanupWidgetStore() {
        const updateKeys = true;
        const widgetJids = await this.getWidgetJids(updateKeys);

        const storeData = this.getStore();

        Object.keys(storeData).forEach((storeKey) => {
            if (storeKey.startsWith('widget-chat-')) {
                const jid = storeKey.replace('widget-chat-', '');
                const found = widgetJids.find((w) => w === jid);

                if (!found) {
                    this.homey.app.log(`[Device] ${this.getName()} - cleanupWidgetStore - removing key`, storeKey);
                    this.unsetStoreValue(storeKey);
                }
            }
        });
    }

    async cleanupWidgetInstanceDuplicates(key, value) {
        const storeData = this.getStore();
        for (const [storeKey, storeValue] of Object.entries(storeData)) {
            if (storeKey.startsWith('widget-instance-') && storeValue === value && storeKey !== key) {
                this.homey.app.log(`[Device] ${this.getName()} - cleanupWidgetDuplicates - removing key`, storeKey, storeValue);
                this.unsetStoreValue(storeKey);
            }
        }
    }
};
