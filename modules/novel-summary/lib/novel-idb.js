"use strict";

// =====================================================================================
// IndexedDB 本地存储：保存当前小说的分段原文与摘要进度
// 每次只保留一本小说（key 固定为 'current'），换书即覆盖。
// 文件名跟"设置存取"用的 store.js 区分开，避免误认为同一类东西——
// 这里存的是小说原文/进度这种大体量数据，走 IndexedDB；store.js 存的是插件配置开关，走 extension_settings。
// =====================================================================================

const DB_NAME = 'novel-summary-db';
const DB_VERSION = 1;
const STORE_NAME = 'novel';
const RECORD_KEY = 'current';

let dbPromise = null;

function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return dbPromise;
}

// === 主动关闭当前持有的连接（用于"清空数据"删库前，避免 indexedDB.deleteDatabase 被 onblocked 卡住）===
// 平时读写都走上面缓存的长连接，这里只在真正要删库之前调用一次；
// 关闭后把 dbPromise 置空，下次 openDb() 会重新建立连接，不影响正常使用。
export async function closeDb() {
    if (!dbPromise) return;
    try {
        const db = await dbPromise;
        db.close();
    } catch (error) {
        // 打开阶段本身失败的话，dbPromise 已经是个 rejected promise，没有连接需要关
    } finally {
        dbPromise = null;
    }
}

export async function saveNovelState(state) {
    try {
        const db = await openDb();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(state, RECORD_KEY);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error);
        });
    } catch (error) {
        console.warn('[NS] 保存本地进度失败:', error);
        return false;
    }
}

export async function loadNovelState() {
    try {
        const db = await openDb();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).get(RECORD_KEY);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    } catch (error) {
        console.warn('[NS] 读取本地进度失败:', error);
        return null;
    }
}

export async function clearNovelState() {
    try {
        const db = await openDb();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).delete(RECORD_KEY);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error);
        });
    } catch (error) {
        console.warn('[NS] 清除本地进度失败:', error);
        return false;
    }
}
