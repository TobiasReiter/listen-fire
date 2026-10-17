import { Request, Response } from 'express';

// The attribute vocabulary lives with Attio's module; the connector is the
// platform's.
export {
  type AttioConfigurer,
  type AttioAttribute,
  attributeConfigValidator,
  attioAttributeTypeValidator,
  KNOWN_ATTIO_ATTRIBUTE_TYPES,
} from '@listen-fire/attio/attributes';

interface AttioConnector {
  handleCallback(request: Request, response: Response): Promise<void>;
  generateInstallUrl(): Promise<string>;
}

export { AttioConnector };
