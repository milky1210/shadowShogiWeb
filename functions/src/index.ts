import { getApps, initializeApp } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { logger } from 'firebase-functions';
import { onSchedule } from 'firebase-functions/v2/scheduler';

if (getApps().length === 0) initializeApp();

const ROOM_RETENTION_MS = 72 * 60 * 60 * 1000;

export const cleanupExpiredRooms = onSchedule(
  {
    schedule: 'every day 03:15',
    timeZone: 'Asia/Tokyo',
    region: 'asia-southeast1',
    memory: '128MiB',
    maxInstances: 1,
    retryCount: 1,
  },
  async () => {
    const cutoff = Date.now() - ROOM_RETENTION_MS;
    const roomsReference = getDatabase().ref('rooms');
    const [legacyRooms, incrementalRooms] = await Promise.all([
      roomsReference.orderByChild('updatedAt').endAt(cutoff).once('value'),
      roomsReference
        .orderByChild('meta/updatedAt')
        .endAt(cutoff)
        .once('value'),
    ]);

    if (!legacyRooms.exists() && !incrementalRooms.exists()) {
      logger.info('No expired rooms found.');
      return;
    }

    const updates: Record<string, null> = {};
    for (const snapshot of [legacyRooms, incrementalRooms])
      snapshot.forEach((room) => {
        updates[room.key!] = null;
      });
    await roomsReference.update(updates);
    logger.info('Expired rooms removed.', {
      count: Object.keys(updates).length,
      cutoff,
    });
  },
);
