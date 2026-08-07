// Firebase 專案設定。
// 注意：這裡的 apiKey 等值是設計成可以公開放在前端程式碼裡的，
// 真正的存取控制交給 Firestore 安全規則（見 Firebase Console）。
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyD3uAhp4Rc9rCbjpzx6RXKvNqlF8CNifV0",
  authDomain: "jp-vocab-98f5d.firebaseapp.com",
  projectId: "jp-vocab-98f5d",
  storageBucket: "jp-vocab-98f5d.firebasestorage.app",
  messagingSenderId: "208421130000",
  appId: "1:208421130000:web:625d40944184899b225f95",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
