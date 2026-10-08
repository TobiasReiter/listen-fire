import winston from 'winston';
import stringify from 'safe-stable-stringify';

import { currentContextId } from './context/current_id';

const isDev = process.env.NODE_ENV === 'development';
const level = isDev ? 'debug' : 'info';

const replacer = (_: string, value: unknown) => {
  if (value instanceof Error) {
    return {
      ...value,
      message: value.message,
      stack: value.stack,
      // @ts-ignore
      trace: value.trace,
    };
  }
  return value;
};

// Drop-in replacement for winston.format.simple() (see logform's simple.js) that
// stringifies the rest-metadata with `replacer` so Error values in metadata
// (e.g. `logger.warn('msg', { error: e })`) keep their message/stack instead of
// serializing to `{}` (Error's own properties are non-enumerable).
const simple = () =>
  winston.format.printf((info) => {
    const stringifiedRest = stringify({ ...info, level: undefined, message: undefined, splat: undefined }, replacer);
    const padding = (info.padding && info.padding[info.level]) || '';
    return stringifiedRest !== '{}'
      ? `${info.level}:${padding} ${info.message} ${stringifiedRest}`
      : `${info.level}:${padding} ${info.message}`;
  });

const format = isDev
  ? winston.format.combine(
      winston.format.colorize(),
      winston.format((info) => {
        const ctxId = currentContextId();
        if (ctxId !== undefined) {
          const ctxIdString = process.env.NODE_ENV === 'development' ? ctxId.slice(0, 8) : ctxId;
          info.message = `[${ctxIdString}] ${
            info.message.toString() === '[object Object]'
              ? stringify(info.message, replacer, 2)
              : info.message.toString()
          }`;
        }
        return info;
      })(),
      simple(),
    )
  : winston.format.combine(
      winston.format((info) => {
        const ctxId = currentContextId();
        if (ctxId !== undefined) {
          info.message = `[${ctxId}] ${
            info.message.toString() === '[object Object]'
              ? stringify(info.message, replacer, 2)
              : info.message.toString()
          }`;
        }
        return info;
      })(),
      simple(),
    );

/** Winston Logger */
const logger = winston.createLogger({
  transports: [new winston.transports.Console({ handleExceptions: true })],
  level,
  format,
});

export { logger };
