import { fastify, FastifyInstance } from 'fastify';
import fastifyAmqpAsync from 'fastify-amqp-async';
import fastifyGracefulShutdown from 'fastify-graceful-shutdown';
import { IncomingMessage, Server, ServerResponse } from 'http';
import { EnvConfig } from './config/env-config';
import { IdentityConfig, YamlConfig } from './config/yaml-config.types';
import { registerConsumers } from './consumer/build-consumer';
import { Consumer } from './consumer/consumer';
import {
    gracefullyHandleSubscriberShutdown,
    handleChannelClose,
    handleConnectionClose,
    shutdownMetricsServer
} from './lifecycle';
import { MetricsCollector } from './metrics/metrics-collector';
import { registerPublishers } from './publisher/build-publisher';
import { Publisher } from './publisher/publisher';
import { registerSubscribers } from './subscriber/build-subscriber';
import { Subscriber } from './subscriber/subscriber';

export type AppInstance = FastifyInstance<Server, IncomingMessage, ServerResponse>;

declare module 'fastify' {
    export interface FastifyInstance {
        publishers: Array<Publisher>;
        consumers: Array<Consumer>;
        subscribers: Array<Subscriber>;
        identities: Array<IdentityConfig>;
        /**
         * In pendingShutdown state, the server is handling a graceful shutdown during which
         * all incoming requests will receive 503 HTTP code while all the existing ones will
         * continue processing. It will also wait for consumers to finish processing messages.
         */
        pendingShutdown: boolean;
        /**
         * Error shutdown occurs when an AMQP channel or connection is closed unexpectedly.
         */
        errorShutdown: boolean;
        metrics: MetricsCollector;
    }
}

function buildApp(
    envConfig: EnvConfig,
    yamlConfig: YamlConfig,
    metrics: MetricsCollector
): AppInstance {
    const app: FastifyInstance<Server, IncomingMessage, ServerResponse> = fastify({
        logger: {
            prettyPrint: envConfig.prettyPrint
                ? {
                    translateTime: 'HH:MM:ss Z'
                }
                : false,
            level: envConfig.logLevel
        },
        pluginTimeout: 30000
    });

    app.decorate('publishers', [] as Array<Publisher>);
    app.decorate('consumers', [] as Array<Consumer>);
    app.decorate('subscribers', [] as Array<Subscriber>);
    app.decorate('identities', yamlConfig.identities);
    app.decorate('pendingShutdown', false);
    app.decorate('errorShutdown', false);
    app.decorate('metrics', metrics);

    app.get('/', (req, res) => {
        res.send(`Hello from Bunny REST Proxy`);
    });

    app.removeAllContentTypeParsers();

    app.addContentTypeParser('*', { parseAs: 'buffer' }, function (_req, body, done) {
        done(null, body);
    });

    app.register(fastifyGracefulShutdown);

    app.register(fastifyAmqpAsync, {
        connectionString: envConfig.connectionString,
        useConfirmChannel: true,
        useRegularChannel: true,
        ignoreOnClose: true
    }).after((err) => {
        if (err) {
            app.log.fatal(`Error connecting to RabbitMQ, message: ${err.message}`);
            process.exit(1);
        }

        registerPublishers(yamlConfig.publishers, app, metrics);
        registerConsumers(yamlConfig.consumers, app, metrics);
        registerSubscribers(yamlConfig.subscribers, app, metrics);
    });

    app.addHook('onReady', async () => {
        app.amqp.connection.on('close', () => {
            handleConnectionClose(app);
        });
        app.amqp.confirmChannel.on('close', () => {
            handleChannelClose(app, true);
        });
        app.amqp.channel.on('close', () => {
            handleChannelClose(app, false);
        });

        for (const publisher of app.publishers) {
            await publisher.assertQueue();
        }
        for (const subscriber of app.subscribers) {
            await subscriber.start();
        }
    });

    app.addHook('onClose', async () => {
        await Promise.allSettled([
            gracefullyHandleSubscriberShutdown(app),
            shutdownMetricsServer(app)
        ]);
    });

    app.after(() => {
        app.gracefulShutdown((signal, next) => {
            app.log.info('Starting graceful shutdown sequence.');
            app.pendingShutdown = true;
            next();
        });
    });

    return app;
}

export default buildApp;
