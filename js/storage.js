/**
 * storage.js
 * -----------------------------------------------------------------------
 * IndexedDB: เก็บข้อมูลก้อนใหญ่ที่เปลี่ยนบ่อย — เอกสาร (pages+layers), โปรไฟล์ลายมือ
 * localStorage: เก็บเฉพาะ preference เล็กๆ (เช่น ธีม, ค่า default sliders, id เอกสารล่าสุด)
 *
 * ทุกฟังก์ชันเป็น async และมี try/catch ครอบ เพื่อจัดการ quota error / เบราว์เซอร์ที่ปิด IndexedDB
 * -----------------------------------------------------------------------
 */

const DB_NAME = "handwriting_homework_db";
const DB_VERSION = 1;
const STORE_DOCUMENTS = "documents";
const STORE_PROFILES = "profiles";

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("เบราว์เซอร์นี้ไม่รองรับ IndexedDB"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_DOCUMENTS)) {
        db.createObjectStore(STORE_DOCUMENTS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_PROFILES)) {
        db.createObjectStore(STORE_PROFILES, { keyPath: "id" });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = () => reject(req.error || new Error("เปิด IndexedDB ไม่สำเร็จ"));
  });
  return dbPromise;
}

async function txStore(storeName, mode) {
  const db = await openDB();
  const tx = db.transaction(storeName, mode);
  return { tx, store: tx.objectStore(storeName) };
}

function wrapRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB request ล้มเหลว"));
  });
}

/** จัดการ error ที่พบบ่อย เช่น QuotaExceededError ให้ข้อความที่อ่านเข้าใจง่าย */
function describeStorageError(err) {
  if (!err) return "เกิดข้อผิดพลาดไม่ทราบสาเหตุ";
  if (err.name === "QuotaExceededError") {
    return "พื้นที่จัดเก็บของเบราว์เซอร์เต็ม กรุณาลบเอกสารเก่าหรือโปรไฟล์ลายมือที่ไม่ใช้แล้ว";
  }
  return err.message || String(err);
}

/* ============================ Documents ============================ */

export async function saveDocument(doc) {
  try {
    doc.updatedAt = Date.now();
    const { tx, store } = await txStore(STORE_DOCUMENTS, "readwrite");
    store.put(doc);
    return await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(new Error(describeStorageError(tx.error)));
    });
  } catch (err) {
    throw new Error(describeStorageError(err));
  }
}

export async function loadDocument(id) {
  const { store } = await txStore(STORE_DOCUMENTS, "readonly");
  return wrapRequest(store.get(id));
}

export async function listDocuments() {
  const { store } = await txStore(STORE_DOCUMENTS, "readonly");
  const all = await wrapRequest(store.getAll());
  return (all || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function deleteDocument(id) {
  const { tx, store } = await txStore(STORE_DOCUMENTS, "readwrite");
  store.delete(id);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(new Error(describeStorageError(tx.error)));
  });
}

/* ============================ Handwriting profiles ============================ */

export async function saveProfile(profile) {
  try {
    profile.updatedAt = Date.now();
    const { tx, store } = await txStore(STORE_PROFILES, "readwrite");
    store.put(profile);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(new Error(describeStorageError(tx.error)));
    });
  } catch (err) {
    throw new Error(describeStorageError(err));
  }
}

export async function loadProfile(id) {
  const { store } = await txStore(STORE_PROFILES, "readonly");
  return wrapRequest(store.get(id));
}

export async function listProfiles() {
  const { store } = await txStore(STORE_PROFILES, "readonly");
  const all = await wrapRequest(store.getAll());
  return all || [];
}

export async function deleteProfile(id) {
  const { tx, store } = await txStore(STORE_PROFILES, "readwrite");
  store.delete(id);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(new Error(describeStorageError(tx.error)));
  });
}

/* ============================ Small preferences (localStorage) ============================ */

const PREF_KEY = "hh_prefs_v1";

export function getPrefs() {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function setPrefs(patch) {
  try {
    const current = getPrefs();
    const next = { ...current, ...patch };
    localStorage.setItem(PREF_KEY, JSON.stringify(next));
    return next;
  } catch (err) {
    console.warn("[storage] บันทึก preference ไม่สำเร็จ:", describeStorageError(err));
    return getPrefs();
  }
}

/* ============================ Profile JSON export/import ============================ */

export function exportProfileAsJSON(profile) {
  return JSON.stringify(profile, null, 2);
}

/** ตรวจสอบโครงสร้างขั้นต่ำก่อน import กันไฟล์เสีย/ปลอม ทำให้แอปพัง */
export function validateProfileJSON(jsonString) {
  let data;
  try {
    data = JSON.parse(jsonString);
  } catch {
    return { valid: false, error: "ไฟล์ไม่ใช่ JSON ที่ถูกต้อง" };
  }
  if (!data || typeof data !== "object") return { valid: false, error: "โครงสร้างไฟล์ไม่ถูกต้อง" };
  if (!data.id || typeof data.id !== "string") return { valid: false, error: "ไม่พบ id ของโปรไฟล์" };
  if (!data.samples || typeof data.samples !== "object") return { valid: false, error: "ไม่พบข้อมูลตัวอย่างลายมือ (samples)" };
  if (!data.settings || typeof data.settings !== "object") return { valid: false, error: "ไม่พบการตั้งค่า (settings)" };
  return { valid: true, data };
}
