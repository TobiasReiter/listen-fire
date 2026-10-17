import { z } from 'zod';

import { neverAsAny } from 'movement-engine/public/utils';

type DataMapType = {
  node: Record<string, unknown & { id: string }>;
  edge: Record<string, unknown & { id: string }>;
  meta: Record<string, unknown>;
};

type HNode<
  DataMap extends DataMapType,
  ModelName extends keyof DataMap['node'] & string = keyof DataMap['node'] & string,
> = {
  id: string;
  modelName: ModelName;
  type: 'Node';
  data: DataMap['node'][ModelName];
  meta: DataMap['meta'];
  indices: Set<string>;
};

function serialiseNode<DataMap extends DataMapType>(node: HNode<DataMap>) {
  return {
    id: node.id,
    modelName: node.modelName,
    type: node.type,
    data: node.data,
    meta: node.meta,
    indices: [...node.indices],
  };
}

function nodeIsType<DataMap extends DataMapType, T extends keyof DataMap['node'] & string>(
  type: T,
  node: HNode<DataMap, keyof DataMap['node'] & string>,
): node is HNode<DataMap, T> {
  return node.modelName === type;
}

function edgeIsType<DataMap extends DataMapType, T extends keyof DataMap['edge'] & string>(
  type: T,
  edge: HEdge<DataMap>,
): edge is HEdge<DataMap, T> {
  return edge.modelName === type;
}

type HEdge<
  DataMap extends DataMapType,
  ModelName extends keyof DataMap['edge'] & string = keyof DataMap['edge'] & string,
> = {
  id: string;
  modelName: ModelName;
  isSymmetric: boolean;
  type: 'Edge';
  from: string;
  to: string;
  data: DataMap['edge'][ModelName];
};

function serialiseEdge<DataMap extends DataMapType>(edge: HEdge<DataMap>) {
  return edge;
}

type HObject<
  DataMap extends DataMapType,
  ModelName extends (keyof DataMap['node'] | keyof DataMap['edge']) & string = (
    | keyof DataMap['node']
    | keyof DataMap['edge']
  ) &
    string,
> = HNode<DataMap, ModelName> | HEdge<DataMap, ModelName>;

function serialiseObject<DataMap extends DataMapType>(object: HObject<DataMap>) {
  if (object.type === 'Node') {
    return serialiseNode(object);
  }
  return serialiseEdge(object);
}

function deserialiseObject<DataMap extends DataMapType>(parsed: unknown): HObject<DataMap> {
  try {
    const { type } = z.object({ type: z.enum(['Node', 'Edge']) }).parse(parsed);

    if (type === 'Node') {
      const parsedNode = z
        .object({
          id: z.string(),
          modelName: z.string(),
          type: z.enum(['Node']),
          data: z.any(),
          meta: z.any(),
          indices: z.array(z.string()),
        })
        .parse(parsed);

      return {
        id: parsedNode.id,
        modelName: parsedNode.modelName,
        type: parsedNode.type,
        data: parsedNode.data,
        meta: parsedNode.meta,
        indices: new Set(parsedNode.indices),
      };
    } else if (type === 'Edge') {
      const parsedEdge = z
        .object({
          id: z.string(),
          modelName: z.string(),
          isSymmetric: z.boolean(),
          type: z.enum(['Edge']),
          from: z.string(),
          to: z.string(),
          data: z.any(),
        })
        .parse(parsed);

      return {
        id: parsedEdge.id,
        modelName: parsedEdge.modelName,
        isSymmetric: parsedEdge.isSymmetric,
        type: parsedEdge.type,
        from: parsedEdge.from,
        to: parsedEdge.to,
        data: parsedEdge.data,
      };
    } else {
      throw new Error(`Unknown object type ${neverAsAny(type)}`);
    }
  } catch (_e) {
    throw new Error('Could not deserialise object');
  }
}

type EdgeSubIndex<DataMap extends DataMapType> = Map<string, Map<string, HEdge<DataMap>>>;

type EdgeIndex<DataMap extends DataMapType> = Map<string, EdgeSubIndex<DataMap>>;

export {
  HNode,
  HEdge,
  HObject,
  EdgeSubIndex,
  EdgeIndex,
  nodeIsType,
  edgeIsType,
  DataMapType,
  serialiseObject,
  deserialiseObject,
};
