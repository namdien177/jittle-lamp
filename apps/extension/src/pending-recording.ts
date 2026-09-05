import { sessionArchiveSchema, type SessionArchive } from "@jittle-lamp/shared";

export type PendingRecording = {
  sessionId: string;
  archive: SessionArchive;
  recordingBlob: Blob;
  jsonBlob: Blob;
  evidenceId?: string;
};

// Blobs stay in the extension origin, never in page storage or Chrome's JSON storage.
async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("jittle-lamp-recording-recovery", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("recordings");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction("recordings", mode);
      const request = run(transaction.objectStore("recordings"));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error ?? request.error ?? new Error("Recording storage was interrupted."));
      transaction.onerror = () => reject(transaction.error ?? request.error);
    });
  } finally {
    db.close();
  }
}

export async function storePendingRecording(recording: PendingRecording): Promise<void> {
  await withStore("readwrite", (store) => store.put(recording, recording.sessionId));
}

export async function readPendingRecording(sessionId: string): Promise<PendingRecording | null> {
  const value = await withStore("readonly", (store) => store.get(sessionId));
  if (!value) return null;
  const archive = sessionArchiveSchema.parse(value.archive);
  if (archive.sessionId !== sessionId || !(value.recordingBlob instanceof Blob) || !(value.jsonBlob instanceof Blob)) {
    throw new Error("The saved recording could not be read.");
  }
  return { sessionId, archive, recordingBlob: value.recordingBlob, jsonBlob: value.jsonBlob,
    ...(typeof value.evidenceId === "string" ? { evidenceId: value.evidenceId } : {}) };
}

export async function deletePendingRecording(sessionId: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(sessionId));
}
