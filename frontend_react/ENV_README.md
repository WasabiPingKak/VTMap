# 📦 Vite 環境變數使用說明

本專案使用 Vite 作為前端建構工具，並透過 `.env` 檔案管理不同環境的設定。此文件針對以下三種情境說明如何配置環境變數：

---

## ✅ 三種常見情境

| 編號 | 使用情境描述 | VITE_ENABLE_SETTINGS | 使用的 `.env` 檔案組合 |
|------|----------------|-----------------------|------------------------|
| 1️⃣ | 本地測試所有功能 | `true`                | `.env` + `.env.local` |
| 2️⃣ | 部署到公開環境（無登入） | `false`       | `.env.production` + `.env.production.local` |
| 3️⃣ | 部署 + 登入驗證（未來用） | `true`        | `.env.production` + `.env.production.local` |

---

## ⚙️ 環境變數檔案說明

| 檔案名稱              | 是否加入 Git | 說明 |
|----------------------|--------------|------|
| `.env`               | ✅ 是         | 所有開發者共享設定，開發模式使用 |
| `.env.local`         | ❌ 否         | 含機密資訊的個人設定，例如 Firebase 金鑰 |
| `.env.production`    | ✅ 是         | 正式部署用設定，不包含機密 |
| `.env.production.local` | ❌ 否     | 正式部署用的私密資料，如金鑰與憑證 |
| `.env.example`       | ✅ 是         | 提供格式給其他開發者參考，不含真實資料 |

---

## 📁 Vite 的讀取順序

### `npm run dev`（mode: development）

1. `.env`
2. `.env.local`

### `npm run build`（mode: production）

1. `.env`
2. `.env.local`
3. `.env.production`
4. `.env.production.local`

✅ **後載入的變數會覆蓋前面同名設定。**

---

## 🔐 私密金鑰建議放在：

```
.env.local
.env.production.local
```

這些應加入 `.gitignore`，例如：

```bash
.env.local
.env.*.local
```

---

## 🧠 程式中如何使用？

```js
const showSettings = import.meta.env.VITE_ENABLE_SETTINGS === "true";
const apiUrl = import.meta.env.VITE_API_BASE;
```

⚠️ 只有 `VITE_` 開頭的變數會被 Vite 暴露給前端程式碼！

---

## 🧪 建議用法總結

| 指令             | 套用檔案組合                       | 預期效果 |
|------------------|------------------------------------|----------|
| `npm run dev`     | `.env` + `.env.local`              | 開啟 `/settings`，用 local 金鑰 |
| `npm run build`   | `.env.production` + `.env.production.local` | 預設關閉 `/settings`，登入後視程式判斷是否顯示 |

---
## 🔀 功能開關

| 變數 | 說明 | staging | production |
|------|------|---------|------------|
| `VITE_ENABLE_NETWORK` | 側欄是否顯示「關係網路」入口，值為 `"true"` 才顯示 | `true` | `false` |

---
