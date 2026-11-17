import { describe, it, expect } from 'vitest';
import { StreamBatcher } from '../src/parser/streamBatcher';

function setup(maxProducts: number, maxIntervalMs: number) {
  let clock = 0;
  const sent: Array<{ items: number[]; products: number }> = [];
  const batcher = new StreamBatcher<number>(
    (items, products) => sent.push({ items, products }),
    { maxProducts, maxIntervalMs, now: () => clock },
  );
  const product = (...pieces: number[]) => {
    batcher.sink.push(...pieces);
    batcher.endProduct();
  };
  return { batcher, sent, product, advance: (ms: number) => { clock += ms; } };
}

describe('StreamBatcher', () => {
  it('sends a batch once it holds maxProducts products', () => {
    const { sent, product } = setup(2, 1e9);
    product(1);
    expect(sent).toEqual([]);
    product(2, 3);
    expect(sent).toEqual([{ items: [1, 2, 3], products: 2 }]);
  });

  it('sends early when the interval has passed, so the first geometry does not wait for a full batch', () => {
    const { sent, product, advance } = setup(200, 100);
    product(1);
    advance(150);
    product(2);
    expect(sent).toEqual([{ items: [1, 2], products: 2 }]);
  });

  it('starts the interval again after each batch', () => {
    const { sent, product, advance } = setup(200, 100);
    advance(150);
    product(1);
    expect(sent).toHaveLength(1);
    advance(50);
    product(2);
    expect(sent).toHaveLength(1);
    advance(60);
    product(3);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({ items: [2, 3], products: 2 });
  });

  it('flush sends what is left and nothing when there is nothing', () => {
    const { batcher, sent, product } = setup(10, 1e9);
    product(7);
    batcher.flush();
    batcher.flush();
    expect(sent).toEqual([{ items: [7], products: 1 }]);
  });

  it('counts products without pieces, so progress still moves', () => {
    const { batcher, sent, product } = setup(2, 1e9);
    product();
    product();
    expect(sent).toEqual([{ items: [], products: 2 }]);
    expect(batcher.productCount).toBe(2);
  });

  it('take hands over the waiting batch without sending it, and starts a new one', () => {
    const { batcher, sent, product } = setup(10, 1e9);
    product(1, 2);
    expect(batcher.take()).toEqual({ items: [1, 2], products: 1 });
    expect(batcher.take()).toEqual({ items: [], products: 0 });
    expect(sent).toEqual([]);
  });

  it('never sends anything with infinite limits until asked', () => {
    const { batcher, sent, product, advance } = setup(Infinity, Infinity);
    for (let i = 0; i < 1000; i++) {
      advance(1000);
      product(i);
    }
    expect(sent).toEqual([]);
    expect(batcher.take().products).toBe(1000);
  });

  it('hands each batch its own array', () => {
    const { sent, product } = setup(1, 1e9);
    product(1);
    product(2);
    expect(sent[0].items).not.toBe(sent[1].items);
    expect(sent.map((s) => s.items)).toEqual([[1], [2]]);
  });
});
