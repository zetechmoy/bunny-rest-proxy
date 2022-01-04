import { Channel } from 'amqplib-as-promised/lib';
import { AuthorizedRequestHeaders, IdentityGuard } from '../auth/identity-guard';
import { PublisherConfig, PublisherContentTypes } from '../config/yaml-config.types';
import { BinaryMessageParser } from '../message-parser/binary';
import { JSONMessageParser } from '../message-parser/json';
import { MessageParser } from '../message-parser/message-parser';
import { AppInstance } from '../server';
import { Publisher, PublishRequestHeaders } from './publisher';

function buildPublisher(config: PublisherConfig, amqp: AppInstance['amqp']): Publisher {
    let messageParser: MessageParser;
    if (config.contentType === PublisherContentTypes.BINARY) {
        messageParser = new BinaryMessageParser();
    } else {
        messageParser = new JSONMessageParser(config.schema);
    }

    let channel: Channel;
    if (config.confirm) {
        channel = amqp.confirmChannel;
    } else {
        channel = amqp.channel;
    }

    return new Publisher(config.queueName, channel, messageParser, config.identities);
}

export function registerPublishers(publishersConfig: Array<PublisherConfig>, app: AppInstance) {
    for (const cfg of publishersConfig) {
        const publisher = buildPublisher(cfg, app.amqp);
        app.publishers.push(publisher);

        const identityGuard = new IdentityGuard(publisher, app.identities);

        app.post<{ Headers: PublishRequestHeaders & AuthorizedRequestHeaders; Body: Buffer }>(
            `/publish/${publisher.queueName}`,
            async function (req, res) {
                identityGuard.verifyRequest(req);
                const result = publisher.sendMessage(req.headers, req.body, req.log);
                res.status(201);
                return result;
            }
        );
    }
}
