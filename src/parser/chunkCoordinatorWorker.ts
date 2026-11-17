/**
 * The worker that runs a shared parse's `ChunkCoordinator`. One per shared
 * parse, created and terminated by `WorkerIfcParser`. No web-ifc here.
 */

import { ChunkCoordinator } from './chunkCoordinator';
import type { FromChunkPort, ToCoordinator } from './ifcMessages';

let coordinator: ChunkCoordinator | null = null;

self.onmessage = (event: MessageEvent<ToCoordinator>): void => {
  const msg = event.data;
  switch (msg.type) {
    case 'plan': {
      const ports = msg.ports;
      coordinator = new ChunkCoordinator(msg.ids, ports);
      ports.forEach((port, key) => {
        port.onmessage = (e: MessageEvent<FromChunkPort>): void => coordinator?.receive(key, e.data);
      });
      break;
    }
    case 'fail':
      coordinator?.fail(msg.worker);
      break;
    case 'end':
      coordinator?.end();
      break;
    case 'received':
      coordinator?.received(msg.worker, msg.index);
      break;
  }
};
