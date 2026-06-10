const express = require('express');
const mysql = require('mysql2/promise');
const moment = require('moment-timezone');
const crypto = require('crypto');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const port = 3000;

// =============================================================================
// KONFIGURASI
// =============================================================================
const config = {
    clientId: '5f5aa496-7e16-4ca1-9967-33c768dac6c7',
    clientSecret: 'TM1rVhfaFm5YJxKruHo0nWMWC',
    username: 'LI9019VKS',
    pin: '5m6uYAScSxQtCmU',
    serverKey: 'QtwGEr997XDcmMb1Pq8S5X1N',

    db: {
        host: 'iksk8ss08ocgow0goksoos40',
        user: 'root',
        password: 'mChz0twCg9Pn5SMLDuVFZXwu9Qw9BaFDEft86hubOcuPhZD3cH5wPfKqelFK8tn1',
        database: 'koperasi_linku',
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    }
};

// =============================================================================
// FUNGSI LOGGING
// =============================================================================
const LOG_PATH = path.join(__dirname, 'stderr.log');

function logToFile(message, level = 'INFO') {
    const timestamp = moment.tz('Asia/Jakarta').format('YYYY-MM-DD HH:mm:ss');
    const fullMessage = `[${timestamp}] [${level}] ${message}\n`;
    fs.appendFile(LOG_PATH, fullMessage, (err) => {
        if (err) console.error('❌ Gagal menulis log:', err);
    });
    console.log(fullMessage.trim());
}

function logInfo(msg) { logToFile(msg, 'INFO'); }
function logSuccess(msg) { logToFile(msg, 'SUCCESS'); }
function logWarn(msg) { logToFile(msg, 'WARN'); }
function logError(msg) { logToFile(msg, 'ERROR'); }
function logDb(msg) { logToFile(msg, 'DB'); }
function logHttp(msg) { logToFile(msg, 'HTTP'); }

// =============================================================================
// DATABASE CONNECTION POOL
// =============================================================================
logInfo(`Menginisialisasi koneksi pool ke ${config.db.host}/${config.db.database}...`);
const pool = mysql.createPool(config.db);

// Cek koneksi saat startup
pool.getConnection()
    .then(connection => {
        const threadId = connection.connection.threadId;
        logSuccess(`Koneksi database berhasil — host: ${config.db.host}, db: ${config.db.database}, threadId: ${threadId}`);
        connection.release();
        logDb(`Koneksi startup dilepas kembali ke pool.`);
    })
    .catch(err => {
        logError(`Koneksi database GAGAL saat startup — ${err.message}`);
        logError(`Stack: ${err.stack}`);
    });

// Wrapper getConnection dengan logging detail
const _originalGetConnection = pool.getConnection.bind(pool);
pool.getConnection = async function () {
    logDb(`Mengambil koneksi dari pool...`);
    try {
        const connection = await _originalGetConnection();
        const threadId = connection.connection.threadId;
        logDb(`Koneksi diperoleh (threadId: ${threadId})`);

        // Wrap release() agar terekam di log
        const _originalRelease = connection.release.bind(connection);
        connection.release = function () {
            logDb(`Koneksi dilepas ke pool (threadId: ${threadId})`);
            return _originalRelease();
        };

        return connection;
    } catch (err) {
        logError(`Gagal mengambil koneksi dari pool: ${err.message}`);
        throw err;
    }
};

// =============================================================================
// MIDDLEWARE
// =============================================================================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// Middleware logging setiap request masuk
app.use((req, res, next) => {
    const start = Date.now();
    logHttp(`→ ${req.method} ${req.originalUrl} | IP: ${req.ip} | Body keys: ${Object.keys(req.body || {}).join(', ') || '-'}`);
    res.on('finish', () => {
        const duration = Date.now() - start;
        const level = res.statusCode >= 400 ? 'ERROR' : 'HTTP';
        logToFile(`← ${req.method} ${req.originalUrl} | Status: ${res.statusCode} | ${duration}ms`, level);
    });
    next();
});

// Multer: simpan file di memory (buffer)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // maks 10MB per file
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
            logWarn(`Upload ditolak — bukan gambar: ${file.originalname} (${file.mimetype})`);
            return cb(new Error('Hanya file gambar yang diizinkan.'), false);
        }
        cb(null, true);
    }
});

// =============================================================================
// FUNGSI UTILITAS
// =============================================================================
function getExpiredTimestampLinkqu() {
    return moment.tz('Asia/Jakarta').add(15, 'minutes').format('YYYYMMDDHHmmss');
}

function getExpiredTimestampDb() {
    return moment.tz('Asia/Jakarta').add(15, 'minutes').unix();
}

function generateSignatureVA({ amount, expired, bank_code, partner_reff, customer_id, customer_name, customer_email, clientId, serverKey }) {
    const endpointPath = '/transaction/create/va';
    const method = 'POST';
    const rawValue = amount + expired + bank_code + partner_reff + customer_id + customer_name + customer_email + clientId;
    const cleaned = rawValue.replace(/[^0-9a-zA-Z]/g, '').toLowerCase();
    const signToString = endpointPath + method + cleaned;
    return crypto.createHmac('sha256', serverKey).update(signToString).digest('hex');
}

function generateSignatureQRIS({ amount, expired, partner_reff, customer_id, customer_name, customer_email, clientId, serverKey }) {
    const endpointPath = '/transaction/create/qris';
    const method = 'POST';
    const rawValue = amount + expired + partner_reff + customer_id + customer_name + customer_email + clientId;
    const cleaned = rawValue.replace(/[^0-9a-zA-Z]/g, '').toLowerCase();
    const signToString = endpointPath + method + cleaned;
    return crypto.createHmac('sha256', serverKey).update(signToString).digest('hex');
}

function generatePartnerReff() {
    const prefix = 'INV';
    const timestamp = Date.now();
    const randomStr = crypto.randomBytes(4).toString('hex');
    return `${prefix}-${timestamp}-${randomStr}`;
}

// =============================================================================
// ENDPOINT: CEK ANGGOTA (dipakai form pendaftaran)
// =============================================================================
app.get('/cek-anggota', async (req, res) => {
    const { id } = req.query;
    logInfo(`/cek-anggota dipanggil — user_id: ${id}`);

    if (!id) {
        logWarn('/cek-anggota — parameter id kosong');
        return res.status(400).json({ exists: false, message: 'Parameter id tidak boleh kosong.' });
    }

    try {
        logDb(`Query: SELECT user_id dari anggota WHERE user_id = '${id}'`);
        const [rows] = await pool.query(
            `SELECT COUNT(*) AS count FROM anggota WHERE user_id = ? AND status = 'Aktif'`,
            [id]
        );
        const exists = rows[0].count > 0;
        logInfo(`/cek-anggota — user_id: ${id}, terdaftar: ${exists}`);
        return res.status(200).json({ exists });
    } catch (err) {
        logError(`/cek-anggota — error query: ${err.message}`);
        return res.status(500).json({ exists: false, message: 'Gagal memeriksa anggota.', detail: err.message });
    }
});

// =============================================================================
// ENDPOINT: DAFTAR ANGGOTA BARU (dengan upload foto KTP & selfie)
// =============================================================================
app.post('/daftar', upload.fields([{ name: 'foto_ktp', maxCount: 1 }, { name: 'selfie_ktp', maxCount: 1 }]), async (req, res) => {
    logInfo('/daftar dipanggil — memproses pendaftaran anggota baru...');

    const { id, nama, alamat, nohp, email, nik } = req.body;

    logInfo(`/daftar — data diterima: id=${id}, nama=${nama}, nohp=${nohp}, email=${email}, nik=${nik ? nik.substring(0, 4) + '****' : 'kosong'}`);

    // Validasi field wajib
    if (!id || !nama || !nik) {
        logWarn(`/daftar — validasi gagal: field wajib kosong (id=${id}, nama=${nama}, nik=${nik})`);
        return res.status(400).json({ success: false, message: 'Data tidak lengkap. id, nama, dan nik wajib diisi.' });
    }

    if (!/^\d{16}$/.test(nik)) {
        logWarn(`/daftar — validasi gagal: NIK tidak valid (${nik.length} digit)`);
        return res.status(400).json({ success: false, message: 'NIK harus terdiri dari tepat 16 digit angka.' });
    }

    if (nohp && !/^\d{8,}$/.test(nohp)) {
        logWarn(`/daftar — validasi gagal: nomor HP tidak valid (${nohp})`);
        return res.status(400).json({ success: false, message: 'Nomor HP harus minimal 8 digit angka.' });
    }

    const fotoKtp = req.files?.['foto_ktp']?.[0]?.buffer || null;
    const selfieKtp = req.files?.['selfie_ktp']?.[0]?.buffer || null;

    logInfo(`/daftar — file foto_ktp: ${fotoKtp ? (fotoKtp.length + ' bytes') : 'tidak ada'}`);
    logInfo(`/daftar — file selfie_ktp: ${selfieKtp ? (selfieKtp.length + ' bytes') : 'tidak ada'}`);

    try {
        // Cek apakah user_id sudah terdaftar
        logDb(`Query: SELECT id FROM anggota WHERE user_id = '${id}'`);
        const [existing] = await pool.query(
            `SELECT id FROM anggota WHERE user_id = ? LIMIT 1`,
            [id]
        );

        if (existing.length > 0) {
            logWarn(`/daftar — user_id ${id} sudah terdaftar (id anggota: ${existing[0].id})`);
            return res.status(409).json({ success: false, message: 'Anda sudah terdaftar sebagai anggota.' });
        }

        // Cek apakah NIK sudah dipakai
        logDb(`Query: SELECT id FROM anggota WHERE nik = '${nik.substring(0, 4)}****'`);
        const [nikCheck] = await pool.query(
            `SELECT id FROM anggota WHERE nik = ? LIMIT 1`,
            [nik]
        );

        if (nikCheck.length > 0) {
            logWarn(`/daftar — NIK sudah terdaftar oleh anggota id: ${nikCheck[0].id}`);
            return res.status(409).json({ success: false, message: 'NIK sudah terdaftar.' });
        }

        logDb(`Query: INSERT INTO anggota (user_id, nama, alamat, no_telepon, email, nik, foto_ktp, selfie_ktp, tanggal_bergabung, status)`);
        const [result] = await pool.query(
            `INSERT INTO anggota (user_id, nama, alamat, no_telepon, email, nik, foto_ktp, selfie_ktp, tanggal_bergabung, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURDATE(), 'Aktif')`,
            [id, nama, alamat || null, nohp || null, email || null, nik, fotoKtp, selfieKtp]
        );

        logSuccess(`/daftar — anggota baru berhasil didaftarkan. id_anggota: ${result.insertId}, user_id: ${id}, nama: ${nama}`);
        return res.status(201).json({
            success: true,
            message: 'Pendaftaran berhasil! Selamat datang di koperasi.',
            memberId: result.insertId
        });

    } catch (err) {
        logError(`/daftar — error saat menyimpan data: ${err.message}`);
        logError(`/daftar — stack: ${err.stack}`);
        return res.status(500).json({ success: false, message: 'Gagal mendaftar. Silakan coba lagi.', detail: err.message });
    }
});

// =============================================================================
// ENDPOINT: BUAT VIRTUAL ACCOUNT
// =============================================================================
app.post('/create-va', async (req, res) => {
    logInfo('/create-va — menerima permintaan pembuatan Virtual Account...');
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();
        logDb('/create-va — transaksi DB dimulai');

        const { jumlah, keterangan, anggota_id, jenis_simpanan_id, bank_code } = req.body;
        logInfo(`/create-va — anggota_id: ${anggota_id}, jumlah: ${jumlah}, bank: ${bank_code}, jenis_simpanan_id: ${jenis_simpanan_id}`);

        if (!anggota_id || !jumlah || !jenis_simpanan_id) {
            logWarn('/create-va — validasi gagal: data tidak lengkap');
            await connection.rollback();
            return res.status(400).json({ error: 'Data tidak lengkap' });
        }

        const partner_reff = generatePartnerReff();
        const expiredLinkqu = getExpiredTimestampLinkqu();
        const expiredDb = getExpiredTimestampDb();
        const url_callback = 'https://kop.siappgo.id/callback';
        const signature = generateSignatureVA({
            amount: jumlah, expired: expiredLinkqu, bank_code, partner_reff,
            customer_id: anggota_id, customer_name: req.body.customer_name,
            customer_email: req.body.customer_email,
            clientId: config.clientId, serverKey: config.serverKey
        });

        logInfo(`/create-va — partner_reff: ${partner_reff}, expired: ${expiredLinkqu}`);

        const payload = {
            ...req.body, partner_reff,
            username: config.username, pin: config.pin,
            expired: expiredLinkqu, signature, url_callback,
            amount: jumlah, customer_id: anggota_id
        };
        const headers = { 'client-id': config.clientId, 'client-secret': config.clientSecret };

        logDb(`/create-va — INSERT transaksi anggota_id: ${anggota_id}, jumlah: ${jumlah}`);
        const [transaksiResult] = await connection.query(
            `INSERT INTO transaksi (anggota_id, jenis_simpanan_id, tanggal_transaksi, jumlah, tipe_transaksi, keterangan)
             VALUES (?, ?, NOW(), ?, 'SETORAN ONLINE', ?)`,
            [anggota_id, jenis_simpanan_id, jumlah, keterangan]
        );
        const transaksiId = transaksiResult.insertId;
        logDb(`/create-va — transaksi dibuat, id: ${transaksiId}`);

        logInfo(`/create-va — mengirim request ke LinkQu VA API...`);
        const response = await axios.post('https://api.linkqu.id/linkqu-partner/transaction/create/va', payload, { headers });
        const result = response.data;
        logSuccess(`/create-va — respons LinkQu diterima: va_number=${result.virtual_account}, amount=${result.amount}`);

        logDb(`/create-va — INSERT pembayaran_online, transaksi_id: ${transaksiId}, va_number: ${result.virtual_account}`);
        await connection.query(
            `INSERT INTO pembayaran_online (transaksi_id, partner_reff, jumlah, jenis_pembayaran, va_number, status_pembayaran, expired_at, customer_id, raw_response)
             VALUES (?, ?, ?, 'VA', ?, 'PENDING', FROM_UNIXTIME(?), ?, ?)`,
            [transaksiId, partner_reff, result.amount, result.virtual_account, expiredDb, anggota_id, JSON.stringify(result)]
        );

        await connection.commit();
        logSuccess(`/create-va — selesai. partner_reff: ${partner_reff}, transaksi_id: ${transaksiId}`);
        res.json(result);

    } catch (err) {
        await connection.rollback();
        logError(`/create-va — GAGAL: ${err.message}`);
        logError(`/create-va — detail LinkQu: ${JSON.stringify(err.response?.data)}`);
        res.status(500).json({ error: 'Gagal membuat VA', detail: err.response?.data || err.message });
    } finally {
        connection.release();
    }
});

// =============================================================================
// ENDPOINT: BUAT QRIS
// =============================================================================
app.post('/create-qris', async (req, res) => {
    logInfo('/create-qris — menerima permintaan pembuatan QRIS...');
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();
        logDb('/create-qris — transaksi DB dimulai');

        const { jumlah, keterangan, anggota_id, jenis_simpanan_id } = req.body;
        logInfo(`/create-qris — anggota_id: ${anggota_id}, jumlah: ${jumlah}, jenis_simpanan_id: ${jenis_simpanan_id}`);

        if (!anggota_id || !jumlah || !jenis_simpanan_id) {
            logWarn('/create-qris — validasi gagal: data tidak lengkap');
            await connection.rollback();
            return res.status(400).json({ error: 'Data tidak lengkap' });
        }

        const partner_reff = generatePartnerReff();
        const expiredLinkqu = getExpiredTimestampLinkqu();
        const expiredDb = getExpiredTimestampDb();
        const url_callback = 'https://kop.siappgo.id/callback';
        const signature = generateSignatureQRIS({
            amount: jumlah, expired: expiredLinkqu, partner_reff,
            customer_id: anggota_id,
            customer_name: req.body.customer_name || '',
            customer_email: req.body.customer_email || '',
            clientId: config.clientId, serverKey: config.serverKey
        });

        logInfo(`/create-qris — partner_reff: ${partner_reff}, expired: ${expiredLinkqu}`);

        const payload = {
            ...req.body, partner_reff,
            username: config.username, pin: config.pin,
            expired: expiredLinkqu, signature, url_callback,
            amount: jumlah, customer_id: anggota_id
        };
        const headers = { 'client-id': config.clientId, 'client-secret': config.clientSecret };

        logDb(`/create-qris — INSERT transaksi anggota_id: ${anggota_id}, jumlah: ${jumlah}`);
        const [transaksiResult] = await connection.query(
            `INSERT INTO transaksi (anggota_id, jenis_simpanan_id, tanggal_transaksi, jumlah, tipe_transaksi, keterangan)
             VALUES (?, ?, NOW(), ?, 'SETORAN ONLINE', ?)`,
            [anggota_id, jenis_simpanan_id, jumlah, keterangan]
        );
        const transaksiId = transaksiResult.insertId;
        logDb(`/create-qris — transaksi dibuat, id: ${transaksiId}`);

        logInfo('/create-qris — mengirim request ke LinkQu QRIS API...');
        const response = await axios.post('https://api.linkqu.id/linkqu-partner/transaction/create/qris', payload, { headers });
        const result = response.data;
        logSuccess(`/create-qris — respons LinkQu diterima: imageqris=${result.imageqris ? 'ada' : 'tidak ada'}, amount=${result.amount}`);

        let qrisImageBuffer = null;
        if (result?.imageqris) {
            try {
                logInfo(`/create-qris — mengunduh gambar QRIS dari: ${result.imageqris.trim()}`);
                const imgResp = await axios.get(result.imageqris.trim(), { responseType: 'arraybuffer' });
                qrisImageBuffer = imgResp.data;
                logSuccess(`/create-qris — gambar QRIS berhasil diunduh (${qrisImageBuffer.byteLength} bytes)`);
            } catch (imgErr) {
                logWarn(`/create-qris — gagal mengunduh gambar QRIS: ${imgErr.message}`);
            }
        } else {
            logWarn('/create-qris — tidak ada URL gambar QRIS dari LinkQu');
        }

        logDb(`/create-qris — INSERT pembayaran_online, transaksi_id: ${transaksiId}`);
        await connection.query(
            `INSERT INTO pembayaran_online (transaksi_id, partner_reff, jumlah, jenis_pembayaran, qris_url, status_pembayaran, expired_at, customer_id, raw_response, qris_image)
             VALUES (?, ?, ?, 'QRIS', ?, 'PENDING', FROM_UNIXTIME(?), ?, ?, ?)`,
            [transaksiId, partner_reff, result.amount, result.imageqris, expiredDb, anggota_id, JSON.stringify(result), qrisImageBuffer]
        );

        await connection.commit();
        logSuccess(`/create-qris — selesai. partner_reff: ${partner_reff}, transaksi_id: ${transaksiId}`);
        res.json(result);

    } catch (err) {
        await connection.rollback();
        logError(`/create-qris — GAGAL: ${err.message}`);
        logError(`/create-qris — detail LinkQu: ${JSON.stringify(err.response?.data)}`);
        res.status(500).json({ error: 'Gagal membuat QRIS', detail: err.response?.data || err.message });
    } finally {
        connection.release();
    }
});

// =============================================================================
// ENDPOINT: DOWNLOAD GAMBAR QRIS
// =============================================================================
app.get('/download-qris/:partner_reff', async (req, res) => {
    const { partner_reff } = req.params;
    logInfo(`/download-qris — partner_reff: ${partner_reff}`);
    const connection = await pool.getConnection();

    try {
        logDb(`/download-qris — query gambar untuk partner_reff: ${partner_reff}`);
        const [rows] = await connection.query(
            `SELECT qris_image FROM pembayaran_online WHERE partner_reff = ? LIMIT 1`,
            [partner_reff]
        );

        if (rows.length === 0 || !rows[0].qris_image) {
            logWarn(`/download-qris — data tidak ditemukan atau gambar kosong untuk: ${partner_reff}`);
            return res.status(404).send('QRIS tidak ditemukan atau tidak memiliki data gambar.');
        }

        const size = rows[0].qris_image.length;
        logSuccess(`/download-qris — mengirim gambar QRIS (${size} bytes) untuk: ${partner_reff}`);
        res.setHeader('Content-Disposition', `attachment; filename="qris-${partner_reff}.png"`);
        res.setHeader('Content-Type', 'image/png');
        return res.send(rows[0].qris_image);

    } catch (err) {
        logError(`/download-qris — error: ${err.message}`);
        res.status(500).send('Terjadi kesalahan server saat mengunduh gambar.');
    } finally {
        connection.release();
    }
});

// =============================================================================
// ENDPOINT: CEK STATUS PEMBAYARAN BY CUSTOMER
// =============================================================================
app.get('/cek-status-pembayaran-by-customer/:customer_id', async (req, res) => {
    const { customer_id } = req.params;
    logInfo(`/cek-status-pembayaran-by-customer — customer_id: ${customer_id}`);
    const connection = await pool.getConnection();

    try {
        logDb(`/cek-status — query transaksi terakhir untuk customer_id: ${customer_id}`);
        const [rows] = await connection.query(
            `SELECT status_pembayaran, jenis_pembayaran, va_number, qris_url, jumlah,
                    expired_at, keterangan, id_pembayaran, partner_reff
             FROM pembayaran_online
             WHERE customer_id = ?
             ORDER BY created_at DESC LIMIT 1`,
            [customer_id]
        );

        if (rows.length === 0) {
            logWarn(`/cek-status — tidak ada transaksi untuk customer_id: ${customer_id}`);
            return res.status(404).json({ error: 'Tidak ada transaksi ditemukan.' });
        }

        const t = rows[0];
        logSuccess(`/cek-status — ditemukan: id_pembayaran=${t.id_pembayaran}, status=${t.status_pembayaran}`);
        res.json({ status: t.status_pembayaran, data: t });

    } catch (err) {
        logError(`/cek-status — error: ${err.message}`);
        res.status(500).json({ error: 'Terjadi kesalahan server.' });
    } finally {
        connection.release();
    }
});

// =============================================================================
// ENDPOINT: RIWAYAT PEMBAYARAN BY ANGGOTA
// =============================================================================
app.get('/cek-history-pembayaran/:anggota_id', async (req, res) => {
    const { anggota_id } = req.params;
    logInfo(`/cek-history-pembayaran — anggota_id: ${anggota_id}`);
    const connection = await pool.getConnection();

    try {
        logDb(`/cek-history — query riwayat untuk anggota_id: ${anggota_id}`);
        const [rows] = await connection.query(`
            SELECT
                po.id_pembayaran, po.partner_reff, po.jumlah,
                po.jenis_pembayaran, po.va_number, po.qris_url,
                po.status_pembayaran, po.expired_at, po.created_at,
                t.keterangan, t.tipe_transaksi,
                CASE WHEN po.jenis_pembayaran = 'VA'
                     THEN JSON_EXTRACT(po.raw_response, '$.bank_name')
                     ELSE NULL END AS bank_name
            FROM pembayaran_online AS po
            JOIN transaksi AS t ON po.transaksi_id = t.id
            WHERE po.customer_id = ?
            ORDER BY po.created_at DESC
        `, [anggota_id]);

        if (rows.length === 0) {
            logWarn(`/cek-history — tidak ada riwayat untuk anggota_id: ${anggota_id}`);
            return res.status(404).json({ error: 'Tidak ada riwayat transaksi ditemukan.' });
        }

        logSuccess(`/cek-history — ditemukan ${rows.length} transaksi untuk anggota_id: ${anggota_id}`);
        res.json({ history: rows });

    } catch (err) {
        logError(`/cek-history — error: ${err.message}`);
        res.status(500).json({ error: 'Terjadi kesalahan server saat mengambil riwayat pembayaran.' });
    } finally {
        connection.release();
    }
});

// =============================================================================
// ENDPOINT: CALLBACK PEMBAYARAN (dari LinkQu)
// =============================================================================
app.post('/callback', async (req, res) => {
    logInfo(`/callback — payload diterima: ${JSON.stringify(req.body)}`);
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();
        logDb('/callback — transaksi DB dimulai');

        const { partner_reff, status, amount, va_code } = req.body;
        logInfo(`/callback — partner_reff: ${partner_reff}, status: ${status}, amount: ${amount}, va_code: ${va_code}`);

        if (!partner_reff) {
            logWarn('/callback — partner_reff tidak ada dalam payload');
            await connection.rollback();
            return res.status(400).json({ error: 'partner_reff wajib ada.' });
        }

        // Idempotency check
        logDb(`/callback — cek status saat ini untuk partner_reff: ${partner_reff}`);
        const [statusRows] = await connection.query(
            `SELECT status_pembayaran FROM pembayaran_online WHERE partner_reff = ? LIMIT 1`,
            [partner_reff]
        );

        if (statusRows.length === 0) {
            logWarn(`/callback — partner_reff tidak ditemukan di DB: ${partner_reff}`);
            await connection.rollback();
            return res.status(404).json({ error: 'Transaksi tidak ditemukan.' });
        }

        if (statusRows[0].status_pembayaran === 'SUKSES') {
            logWarn(`/callback — transaksi ${partner_reff} sudah SUKSES sebelumnya, skip`);
            await connection.commit();
            return res.status(200).json({ message: 'Transaksi sudah SUKSES sebelumnya. Tidak diproses ulang.' });
        }

        if (status !== 'SUCCESS') {
            logInfo(`/callback — status bukan SUCCESS (${status}), tidak update saldo`);
            await connection.rollback();
            return res.status(200).json({ message: 'Callback diterima, tetapi pembayaran belum SUKSES.' });
        }

        // Ambil data anggota
        logDb(`/callback — query anggota_id untuk partner_reff: ${partner_reff}`);
        const [dataRows] = await connection.query(`
            SELECT t.anggota_id
            FROM pembayaran_online AS po
            JOIN transaksi AS t ON po.transaksi_id = t.id
            WHERE po.partner_reff = ? LIMIT 1
        `, [partner_reff]);

        if (dataRows.length === 0) {
            logError(`/callback — data transaksi tidak ditemukan untuk partner_reff: ${partner_reff}`);
            await connection.rollback();
            return res.status(404).json({ error: 'Data transaksi tidak ditemukan.' });
        }

        const { anggota_id } = dataRows[0];

        // Hitung biaya admin
        let adminFee;
        if (va_code === 'QRIS') {
            adminFee = Math.ceil(amount * 0.008);
            logInfo(`/callback — metode QRIS, biaya admin 0.8%: ${adminFee}`);
        } else {
            adminFee = 2500;
            logInfo(`/callback — metode VA/lainnya, biaya admin tetap: ${adminFee}`);
        }
        const netAmount = amount - adminFee;
        logInfo(`/callback — jumlah kotor: ${amount}, biaya admin: ${adminFee}, jumlah bersih: ${netAmount}`);

        // Update saldo
        logDb(`/callback — UPDATE saldo anggota_id: ${anggota_id} += ${netAmount}`);
        await connection.query(
            `UPDATE anggota SET saldo = saldo + ? WHERE id = ?`,
            [netAmount, anggota_id]
        );

        // Update status pembayaran
        logDb(`/callback — UPDATE status pembayaran ke SUKSES untuk: ${partner_reff}`);
        await connection.query(
            `UPDATE pembayaran_online SET status_pembayaran = 'SUKSES' WHERE partner_reff = ?`,
            [partner_reff]
        );

        await connection.commit();
        logSuccess(`/callback — SELESAI. partner_reff: ${partner_reff}, anggota_id: ${anggota_id}, saldo +${netAmount}`);
        res.status(200).json({ message: 'Callback diterima dan saldo ditambahkan.' });

    } catch (err) {
        await connection.rollback();
        logError(`/callback — GAGAL: ${err.message}`);
        logError(`/callback — stack: ${err.stack}`);
        res.status(500).json({ error: 'Gagal memproses callback', detail: err.message });
    } finally {
        connection.release();
    }
});

// =============================================================================
// ENDPOINT: DETAIL ANGGOTA BY NAMA
// =============================================================================
app.get('/api/member-details', async (req, res) => {
    const { nama } = req.query;
    logInfo(`/api/member-details — dipanggil, nama: ${nama}`);

    if (!nama) {
        logWarn('/api/member-details — parameter nama kosong');
        return res.status(400).json({ success: false, message: 'Nama anggota tidak boleh kosong.' });
    }

    try {
        logDb(`/api/member-details — query SELECT * FROM anggota WHERE nama = '${nama}'`);
        const [rows] = await pool.query(`SELECT * FROM anggota WHERE nama = ?`, [nama]);

        if (rows.length === 0) {
            logWarn(`/api/member-details — anggota tidak ditemukan: ${nama}`);
            return res.status(404).json({ success: false, message: 'Anggota tidak ditemukan.' });
        }

        logSuccess(`/api/member-details — data ditemukan untuk: ${nama} (id: ${rows[0].id})`);
        res.status(200).json({ success: true, data: rows[0] });

    } catch (err) {
        logError(`/api/member-details — error: ${err.message}`);
        return res.status(500).json({ success: false, message: 'Gagal mengambil data anggota.', error: err.message });
    }
});

// =============================================================================
// ENDPOINT: REGISTER ANGGOTA (versi sederhana tanpa upload)
// =============================================================================
app.post('/api/register-member', async (req, res) => {
    const { nama, alamat, no_telepon } = req.body;
    logInfo(`/api/register-member — nama: ${nama}, no_telepon: ${no_telepon}`);

    if (!nama) {
        logWarn('/api/register-member — nama tidak diisi');
        return res.status(400).json({ success: false, message: 'Nama harus diisi.' });
    }

    try {
        logDb(`/api/register-member — INSERT anggota nama: ${nama}`);
        const [result] = await pool.query(
            `INSERT INTO anggota (nama, alamat, no_telepon, tanggal_bergabung, status) VALUES (?, ?, ?, CURDATE(), 'Aktif')`,
            [nama, alamat, no_telepon]
        );
        logSuccess(`/api/register-member — berhasil, id: ${result.insertId}`);
        res.status(201).json({ success: true, message: 'Anggota berhasil didaftarkan!', memberId: result.insertId });

    } catch (err) {
        logError(`/api/register-member — error: ${err.message}`);
        return res.status(500).json({ success: false, message: 'Gagal mendaftar anggota.', error: err.message });
    }
});

// =============================================================================
// ENDPOINT: CEK KETERSEDIAAN NAMA ANGGOTA
// =============================================================================
app.get('/api/check-member', async (req, res) => {
    const { nama } = req.query;
    logInfo(`/api/check-member — nama: ${nama}`);

    if (!nama) {
        return res.status(400).json({ success: false, message: 'Nama tidak boleh kosong.' });
    }

    try {
        logDb(`/api/check-member — COUNT anggota WHERE nama = '${nama}' AND status = 'Aktif'`);
        const [rows] = await pool.query(
            `SELECT COUNT(*) AS count FROM anggota WHERE nama = ? AND status = 'Aktif'`,
            [nama]
        );
        const memberExists = rows[0].count > 0;
        logInfo(`/api/check-member — nama: ${nama}, exists: ${memberExists}`);

        if (memberExists) {
            return res.status(200).json({ exists: true, message: 'Anda sudah terdaftar sebagai anggota aktif.' });
        } else {
            return res.status(200).json({ exists: false, message: 'Nama tersedia untuk pendaftaran.' });
        }
    } catch (err) {
        logError(`/api/check-member — error: ${err.message}`);
        return res.status(500).json({ success: false, message: 'Gagal memeriksa anggota.', detail: err.message });
    }
});

// =============================================================================
// ENDPOINT: RIWAYAT PEMBAYARAN SEMUA ANGGOTA (dengan filter)
// =============================================================================
app.get('/api/history-pembayaran-all', async (req, res) => {
    const { search, status, jenis_simpanan_id } = req.query;
    logInfo(`/api/history-pembayaran-all — filter: search=${search}, status=${status}, jenis_simpanan_id=${jenis_simpanan_id}`);
    const connection = await pool.getConnection();

    try {
        let query = `
            SELECT
                po.id_pembayaran, po.partner_reff,
                po.jumlah AS jumlah_kotor,
                po.jenis_pembayaran, po.status_pembayaran, po.created_at,
                t.keterangan, t.tipe_transaksi,
                a.nama AS nama_anggota,
                js.nama_simpanan AS jenis_simpanan,
                CASE WHEN po.jenis_pembayaran = 'VA'
                     THEN JSON_EXTRACT(po.raw_response, '$.bank_name')
                     ELSE NULL END AS bank_name,
                CASE WHEN po.jenis_pembayaran = 'QRIS' THEN CEIL(po.jumlah * 0.008)
                     WHEN po.jenis_pembayaran = 'VA'   THEN 2500
                     ELSE 0 END AS biaya_admin,
                po.jumlah - (
                    CASE WHEN po.jenis_pembayaran = 'QRIS' THEN CEIL(po.jumlah * 0.008)
                         WHEN po.jenis_pembayaran = 'VA'   THEN 2500
                         ELSE 0 END
                ) AS jumlah_bersih
            FROM pembayaran_online AS po
            JOIN transaksi AS t ON po.transaksi_id = t.id
            JOIN anggota AS a ON t.anggota_id = a.id
            JOIN jenis_simpanan AS js ON t.jenis_simpanan_id = js.id
            WHERE 1=1
        `;
        const params = [];

        if (status && status !== 'ALL') {
            query += ` AND po.status_pembayaran = ?`;
            params.push(status);
            logInfo(`/api/history-all — filter status: ${status}`);
        }
        if (jenis_simpanan_id && jenis_simpanan_id !== 'ALL') {
            query += ` AND t.jenis_simpanan_id = ?`;
            params.push(jenis_simpanan_id);
            logInfo(`/api/history-all — filter jenis_simpanan_id: ${jenis_simpanan_id}`);
        }
        if (search) {
            query += ` AND a.nama LIKE ?`;
            params.push(`%${search}%`);
            logInfo(`/api/history-all — filter search: ${search}`);
        }
        query += ` ORDER BY po.created_at DESC`;

        let totalQuery = `
            SELECT SUM(
                po.jumlah - (
                    CASE WHEN po.jenis_pembayaran = 'QRIS' THEN CEIL(po.jumlah * 0.008)
                         WHEN po.jenis_pembayaran = 'VA'   THEN 2500
                         ELSE 0 END
                )
            ) AS total_nominal
            FROM pembayaran_online AS po
            JOIN transaksi AS t ON po.transaksi_id = t.id
            WHERE po.status_pembayaran = 'SUKSES'
        `;
        const totalParams = [];

        if (jenis_simpanan_id && jenis_simpanan_id !== 'ALL') {
            totalQuery += ` AND t.jenis_simpanan_id = ?`;
            totalParams.push(jenis_simpanan_id);
        }

        logDb(`/api/history-all — menjalankan query utama dan total secara paralel`);
        const [[rows], [totalResult]] = await Promise.all([
            connection.query(query, params),
            connection.query(totalQuery, totalParams)
        ]);

        const total_nominal = totalResult[0].total_nominal || 0;
        logSuccess(`/api/history-all — ditemukan ${rows.length} baris, total_nominal SUKSES: ${total_nominal}`);
        res.json({ history: rows, total_nominal });

    } catch (err) {
        logError(`/api/history-all — error: ${err.message}`);
        res.status(500).json({ error: 'Terjadi kesalahan server saat mengambil riwayat pembayaran.' });
    } finally {
        connection.release();
    }
});

// =============================================================================
// ENDPOINT: DAFTAR JENIS SIMPANAN
// =============================================================================
app.get('/api/jenis-simpanan', async (req, res) => {
    logInfo('/api/jenis-simpanan — dipanggil');
    const connection = await pool.getConnection();

    try {
        logDb('/api/jenis-simpanan — SELECT id, nama_simpanan FROM jenis_simpanan');
        const [rows] = await connection.query(`SELECT id, nama_simpanan FROM jenis_simpanan`);
        logSuccess(`/api/jenis-simpanan — ditemukan ${rows.length} jenis simpanan`);
        res.json({ jenis_simpanan: rows });

    } catch (err) {
        logError(`/api/jenis-simpanan — error: ${err.message}`);
        res.status(500).json({ error: 'Gagal mengambil jenis simpanan.' });
    } finally {
        connection.release();
    }
});

// =============================================================================
// HANDLER: ERROR GLOBAL (multer & lainnya)
// =============================================================================
app.use((err, req, res, next) => {
    if (err.code === 'LIMIT_FILE_SIZE') {
        logWarn(`Upload error — file terlalu besar: ${req.originalUrl}`);
        return res.status(400).json({ success: false, message: 'Ukuran file terlalu besar. Maks 10MB.' });
    }
    logError(`Unhandled error di ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ success: false, message: err.message || 'Terjadi kesalahan server.' });
});

// =============================================================================
// JALANKAN SERVER
// =============================================================================
app.listen(port, () => {
    logSuccess(`Server berjalan di http://localhost:${port}`);
    logInfo(`Log ditulis ke: ${LOG_PATH}`);
});