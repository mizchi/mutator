import { hash } from '@mizchi/mutator-core';

/** One-based partition of mutant keys, independent of coverage, timing and cached verdicts. */
export interface Shard {
  index: number;
  total: number;
}

export function validateShard(shard: Shard): Shard {
  if (!Number.isSafeInteger(shard.index) || !Number.isSafeInteger(shard.total) || shard.index < 1 || shard.total < 1 || shard.index > shard.total) {
    throw new RangeError('shard must be INDEX/COUNT with integers 1 <= INDEX <= COUNT');
  }
  return shard;
}

export function parseShard(value: string): Shard {
  if (!/^[1-9]\d*\/[1-9]\d*$/.test(value)) throw new RangeError('shard must be INDEX/COUNT with integers 1 <= INDEX <= COUNT');
  const [index, total] = value.split('/').map(Number);
  return validateShard({ index: index!, total: total! });
}

export function shardName(shard: Shard): string {
  return `shard-${shard.index}-of-${shard.total}`;
}

export function ownsMutant(key: string, shard: Shard): boolean {
  return Number.parseInt(hash(key), 36) % shard.total === shard.index - 1;
}
