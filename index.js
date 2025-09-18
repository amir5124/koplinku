const express = require('express');
const mysql = require('mysql2/promise');
const moment = require('moment-timezone');
const crypto = require('crypto');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const port = 3000;

// --- KONFIGURASI ---
const config = {
    // Kredensial LinkQu.id
    clientId: '5f5aa496-7e16-4ca1-9967-33c768dac6c7',
    clientSecret: 'TM1rVhfaFm5YJxKruHo0nWMWC',
    username: 'LI9019VKS',
    pin: '5m6uYAScSxQtCmU',
    serverKey: 'QtwGEr997XDcmMb1Pq8S5X1N',

    // Konfigurasi Database
    db: {
        host: 'linku.co.id',
        user: 'linkucoi_koplinku',
        password: '~5m1,Nzg-3vn',
        database: 'linkucoi_koplinku',
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    }
};

// --- DATABASE CONNECTION POOL ---
const pool = mysql.createPool(config.db);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// --- FUNGSI UTILITAS ---
function logToFile(message) {
    const logPath = path.join(__dirname, 'stderr.log');
    const timestamp = new Date().toISOString();
    const fullMessage = `[${timestamp}] ${message}\n`;
    fs.appendFile(logPath, fullMessage, (err) => {
        if (err) {
            console.error("❌ Gagal menulis log:", err);
        }
    });
}

function getExpiredTimestampLinkqu() {
    return moment.tz('Asia/Jakarta').add(15, 'minutes').format('YYYYMMDDHHmmss');
}

function getExpiredTimestampDb() {
    return moment.tz('Asia/Jakarta').add(15, 'minutes').unix();
}

function generateSignatureVA({ amount, expired, bank_code, partner_reff, customer_id, customer_name, customer_email, clientId, serverKey }) {
    const path = '/transaction/create/va';
    const method = 'POST';
    const rawValue = amount + expired + bank_code + partner_reff + customer_id + customer_name + customer_email + clientId;
    const cleaned = rawValue.replace(/[^0-9a-zA-Z]/g, "").toLowerCase();
    const signToString = path + method + cleaned;
    return crypto.createHmac("sha256", serverKey).update(signToString).digest("hex");
}

function generateSignatureQRIS({ amount, expired, partner_reff, customer_id, customer_name, customer_email, clientId, serverKey }) {
    const path = '/transaction/create/qris';
    const method = 'POST';
    const rawValue = amount + expired + partner_reff + customer_id + customer_name + customer_email + clientId;
    const cleaned = rawValue.replace(/[^0-9a-zA-Z]/g, "").toLowerCase();
    const signToString = path + method + cleaned;
    return crypto.createHmac("sha256", serverKey).update(signToString).digest("hex");
}

function generatePartnerReff() {
    const prefix = 'INV';
    const timestamp = Date.now();
    const randomStr = crypto.randomBytes(4).toString('hex');
    return `${prefix}-${timestamp}-${randomStr}`;
}

// --- ENDPOINT PEMBAYARAN ---
app.post('/create-va', async (req, res) => {
    console.log('✅ Menerima permintaan untuk membuat Virtual Account (VA)...');

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();
        const body = req.body;
        const { jumlah, keterangan, anggota_id, jenis_simpanan_id, bank_code } = body;

        console.log(`[REQUEST PAYLOAD]: ${JSON.stringify(body)}`);

        if (!anggota_id || !jumlah || !jenis_simpanan_id) {
            console.log('❌ Data tidak lengkap. Menghentikan transaksi.');
            await connection.rollback();
            return res.status(400).json({ error: "Data tidak lengkap" });
        }

        const partner_reff = generatePartnerReff();
        const expiredLinkqu = getExpiredTimestampLinkqu();
        const expiredDb = getExpiredTimestampDb();
        const url_callback = "https://kop.siappgo.id/callback";

        console.log(`[GENERATED VALUES]: partner_reff: ${partner_reff}, expiredLinkqu: ${expiredLinkqu}, expiredDb: ${expiredDb}`);

        const signature = generateSignatureVA({ amount: jumlah, expired: expiredLinkqu, bank_code, partner_reff, customer_id: anggota_id, customer_name: body.customer_name, customer_email: body.customer_email, clientId: config.clientId, serverKey: config.serverKey });

        const payload = { ...body, partner_reff, username: config.username, pin: config.pin, expired: expiredLinkqu, signature, url_callback, amount: jumlah, customer_id: anggota_id };
        const headers = { 'client-id': config.clientId, 'client-secret': config.clientSecret };

        console.log(`[LINKQU PAYLOAD]: ${JSON.stringify(payload)}`);
        console.log(`[LINKQU HEADERS]: ${JSON.stringify(headers)}`);

        const [transaksiResult] = await connection.query(
            `INSERT INTO transaksi (anggota_id, jenis_simpanan_id, tanggal_transaksi, jumlah, tipe_transaksi, keterangan) VALUES (?, ?, NOW(), ?, ?, ?)`,
            [anggota_id, jenis_simpanan_id, jumlah, 'SETORAN ONLINE', keterangan]
        );
        const transaksiId = transaksiResult.insertId;
        console.log(`[DB INSERT]: Berhasil membuat transaksi dengan ID: ${transaksiId}`);

        const url = 'https://api.linkqu.id/linkqu-partner/transaction/create/va';
        const response = await axios.post(url, payload, { headers });
        const result = response.data;

        console.log(`[LINKQU RESPONSE]: ${JSON.stringify(result)}`);

        // Cek jika ada error dari LinkQu
        if (result.status !== '00') {
            await connection.rollback();
            console.log(`❌ LinkQu mengembalikan status error: ${result.status} - ${result.message}`);
            return res.status(400).json({ error: result.message, linkqu_status: result.status });
        }

        await connection.query(
            `INSERT INTO pembayaran_online (transaksi_id, partner_reff, jumlah, jenis_pembayaran, va_number, status_pembayaran, expired_at, customer_id, raw_response) VALUES (?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?), ?, ?)`,
            [transaksiId, partner_reff, result.amount, 'VA', result.virtual_account, 'PENDING', expiredDb, anggota_id, JSON.stringify(result)]
        );
        console.log('[DB INSERT]: Berhasil menyimpan data pembayaran online.');

        await connection.commit();
        console.log('✅ Transaksi berhasil. Mengirim respons ke klien.');
        res.json(result);

    } catch (err) {
        await connection.rollback();
        console.log(`❌ Gagal membuat VA: ${err.message}`);
        console.log(`[ERROR DETAIL]: ${JSON.stringify(err.response?.data || { message: err.message, stack: err.stack })}`);
        res.status(500).json({ error: "Gagal membuat VA", detail: err.response?.data || err.message });
    } finally {
        if (connection) connection.release();
        console.log('--------------------------------------');
    }
});

app.post('/create-qris', async (req, res) => {
    logToFile('✅ Menerima permintaan untuk membuat QRIS...');
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();
        const body = req.body;
        const { jumlah, keterangan, anggota_id, jenis_simpanan_id } = body;

        if (!anggota_id || !jumlah || !jenis_simpanan_id) {
            await connection.rollback();
            return res.status(400).json({ error: "Data tidak lengkap" });
        }

        const partner_reff = generatePartnerReff();
        const expiredLinkqu = getExpiredTimestampLinkqu();
        const expiredDb = getExpiredTimestampDb();
        const url_callback = "https://kop.siappgo.id/callback";
        const signature = generateSignatureQRIS({
            amount: jumlah,
            expired: expiredLinkqu,
            partner_reff,
            customer_id: anggota_id,
            customer_name: body.customer_name || '',
            customer_email: body.customer_email || '',
            clientId: config.clientId,
            serverKey: config.serverKey
        });

        const payload = {
            ...body,
            partner_reff,
            username: config.username,
            pin: config.pin,
            expired: expiredLinkqu,
            signature,
            url_callback,
            amount: jumlah,
            customer_id: anggota_id
        };
        const headers = {
            'client-id': config.clientId,
            'client-secret': config.clientSecret
        };

        const [transaksiResult] = await connection.query(
            `INSERT INTO transaksi (anggota_id, jenis_simpanan_id, tanggal_transaksi, jumlah, tipe_transaksi, keterangan) VALUES (?, ?, NOW(), ?, ?, ?)`,
            [anggota_id, jenis_simpanan_id, jumlah, 'SETORAN ONLINE', keterangan]
        );
        const transaksiId = transaksiResult.insertId;

        const url = 'https://api.linkqu.id/linkqu-partner/transaction/create/qris';
        const response = await axios.post(url, payload, { headers });
        const result = response.data;

        let qrisImageBuffer = null;
        if (result?.imageqris) {
            try {
                const imgResp = await axios.get(result.imageqris.trim(), { responseType: 'arraybuffer' });
                qrisImageBuffer = imgResp.data;
            } catch (err) {
                console.error("⚠️ Gagal mengunduh gambar QRIS:", err.message);
            }
        }

        await connection.query(
            `INSERT INTO pembayaran_online (transaksi_id, partner_reff, jumlah, jenis_pembayaran, qris_url, status_pembayaran, expired_at, customer_id, raw_response, qris_image) VALUES (?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?), ?, ?, ?)`,
            [transaksiId, partner_reff, result.amount, 'QRIS', result.imageqris, 'PENDING', expiredDb, anggota_id, JSON.stringify(result), qrisImageBuffer]
        );

        await connection.commit();
        logToFile(`✅ QRIS berhasil dibuat untuk transaksi ID: ${transaksiId}`);
        res.json(result);

    } catch (err) {
        await connection.rollback();
        logToFile(`❌ Gagal membuat QRIS: ${err.message}`);
        res.status(500).json({
            error: "Gagal membuat QRIS",
            detail: err.response?.data || err.message
        });
    } finally {
        if (connection) connection.release();
    }
});

app.get('/download-qris/:partner_reff', async (req, res) => {
    const partner_reff = req.params.partner_reff;
    logToFile(`✅ Menerima permintaan untuk mengunduh QRIS dengan partner_reff: ${partner_reff}`);
    const connection = await pool.getConnection();

    try {
        const [rows] = await connection.query(
            `SELECT qris_image FROM pembayaran_online WHERE partner_reff = ? LIMIT 1`,
            [partner_reff]
        );

        if (rows.length === 0 || !rows[0].qris_image) {
            logToFile(`❌ QRIS tidak ditemukan atau tidak memiliki gambar untuk partner_reff: ${partner_reff}`);
            return res.status(404).send('QRIS tidak ditemukan atau tidak memiliki data gambar.');
        }

        const qrisImageBlob = rows[0].qris_image;

        res.setHeader('Content-Disposition', `attachment; filename="qris-${partner_reff}.png"`);
        res.setHeader('Content-Type', 'image/png');
        return res.send(qrisImageBlob);

    } catch (err) {
        logToFile(`❌ Error saat mengunduh QRIS: ${err.message}`);
        console.error(err);
        res.status(500).send('Terjadi kesalahan server saat mengunduh gambar.');
    } finally {
        if (connection) connection.release();
    }
});

app.get('/cek-status-pembayaran-by-customer/:customer_id', async (req, res) => {
    const customer_id = req.params.customer_id;
    console.log(`✅ Menerima permintaan cek status untuk customer_id: ${customer_id}`);
    const connection = await pool.getConnection();

    try {
        const [rows] = await connection.query(
            `SELECT
                status_pembayaran, jenis_pembayaran, va_number, qris_url, jumlah, expired_at, keterangan, id_pembayaran, partner_reff
            FROM pembayaran_online
            WHERE customer_id = ?
            ORDER BY created_at DESC LIMIT 1`,
            [customer_id]
        );

        if (rows.length === 0) {
            logToFile(`❌ Tidak ada transaksi ditemukan untuk customer_id: ${customer_id}`);
            return res.status(404).json({ error: "Tidak ada transaksi ditemukan." });
        }

        const latestTransaction = rows[0];

        res.json({
            status: latestTransaction.status_pembayaran,
            data: latestTransaction
        });

    } catch (err) {
        logToFile(`❌ Error saat cek status pembayaran by customer: ${err.message}`);
        res.status(500).json({ error: "Terjadi kesalahan server." });
    } finally {
        if (connection) connection.release();
    }
});

app.get('/cek-history-pembayaran/:anggota_id', async (req, res) => {
    const anggotaId = req.params.anggota_id;
    logToFile(`✅ Menerima permintaan riwayat pembayaran untuk anggota_id: ${anggotaId}`);
    const connection = await pool.getConnection();

    try {
        const query = `
            SELECT
                po.id_pembayaran,
                po.partner_reff,
                po.jumlah,
                po.jenis_pembayaran,
                po.va_number,
                po.qris_url,
                po.status_pembayaran,
                po.expired_at,
                po.created_at,
                t.keterangan,
                t.tipe_transaksi
            FROM
                pembayaran_online AS po
            JOIN
                transaksi AS t ON po.transaksi_id = t.id
            WHERE
                po.customer_id = ?
            ORDER BY
                po.created_at DESC;
        `;

        const [rows] = await connection.query(query, [anggotaId]);
        if (rows.length === 0) {
            logToFile(`❌ Tidak ada riwayat transaksi ditemukan untuk anggota_id: ${anggotaId}`);
            return res.status(404).json({ error: "Tidak ada riwayat transaksi ditemukan." });
        }
        res.json({ history: rows });
    } catch (err) {
        logToFile(`❌ Error saat mengambil riwayat pembayaran: ${err.message}`);
        res.status(500).json({ error: "Terjadi kesalahan server saat mengambil riwayat pembayaran." });
    } finally {
        if (connection) connection.release();
    }
});

app.post("/callback", async (req, res) => {
    logToFile(`✅ Callback diterima: ${JSON.stringify(req.body)}`);
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();
        const { partner_reff } = req.body;
        const [statusRows] = await connection.query(`SELECT status_pembayaran FROM pembayaran_online WHERE partner_reff = ? LIMIT 1`, [partner_reff]);

        if (statusRows.length > 0 && statusRows[0].status_pembayaran === 'SUKSES') {
            logToFile(`ℹ️ Transaksi ${partner_reff} sudah SUKSES sebelumnya. Tidak diproses ulang.`);
            await connection.commit();
            res.status(200).json({ message: "Transaksi sudah SUKSES sebelumnya. Tidak diproses ulang." });
            return;
        }

        const paymentStatusFromCallback = req.body.status;
        if (paymentStatusFromCallback === 'SUCCESS') {
            const [dataRows] = await connection.query(`SELECT t.jumlah, t.anggota_id FROM pembayaran_online AS po JOIN transaksi AS t ON po.transaksi_id = t.id WHERE po.partner_reff = ? LIMIT 1`, [partner_reff]);

            if (dataRows.length === 0) {
                logToFile(`❌ Data transaksi tidak ditemukan untuk Partner Reff: ${partner_reff}.`);
                await connection.rollback();
                res.status(404).json({ error: "Data transaksi tidak ditemukan." });
                return;
            }

            const { jumlah, anggota_id } = dataRows[0];
            await connection.query(`UPDATE anggota SET saldo = saldo + ? WHERE id = ?`, [jumlah, anggota_id]);
            logToFile(`✅ Saldo anggota ID ${anggota_id} berhasil ditambahkan sejumlah ${jumlah}.`);

            await connection.query(`UPDATE pembayaran_online SET status_pembayaran = 'SUKSES' WHERE partner_reff = ?`, [partner_reff]);
            logToFile(`✅ Status pembayaran untuk Partner Reff ${partner_reff} berhasil diperbarui menjadi SUKSES.`);

            await connection.commit();
            logToFile(`✅ Transaksi ${partner_reff} selesai diproses.`);
            res.status(200).json({ message: "Callback diterima dan saldo ditambahkan" });
        } else {
            logToFile(`ℹ️ Callback untuk transaksi ${partner_reff} diterima, tetapi statusnya bukan SUCCESS.`);
            await connection.rollback();
            res.status(200).json({ message: "Callback diterima, tetapi pembayaran belum SUKSES" });
        }
    } catch (err) {
        await connection.rollback();
        logToFile(`❌ Gagal memproses callback: ${err.message}`);
        res.status(500).json({ error: "Gagal memproses callback", detail: err.message });
    } finally {
        if (connection) connection.release();
    }
});

app.get('/api/member-details', async (req, res) => {
    logToFile('API /api/member-details dipanggil.');
    const { nama } = req.query;

    if (!nama) {
        logToFile('Error: Nama anggota pada query kosong.');
        return res.status(400).json({ success: false, message: 'Nama anggota tidak boleh kosong.' });
    }

    try {
        const [rows] = await pool.query(`SELECT * FROM anggota WHERE nama = ?`, [nama]);
        if (rows.length === 0) {
            logToFile(`Anggota tidak ditemukan: ${nama}`);
            return res.status(404).json({ success: false, message: 'Anggota tidak ditemukan.' });
        }
        logToFile('Detail anggota ditemukan. Mengirim data.');
        res.status(200).json({ success: true, data: rows[0] });
    } catch (err) {
        logToFile(`Error saat mengambil detail anggota: ${err}`);
        return res.status(500).json({ success: false, message: 'Gagal mengambil data anggota.', error: err.message });
    }
});

app.post('/api/register-member', async (req, res) => {
    logToFile('API /api/register-member dipanggil.');
    const { nama, alamat, no_telepon } = req.body;
    if (!nama) {
        logToFile('Error: Nama tidak diisi.');
        return res.status(400).json({ success: false, message: 'Nama harus diisi.' });
    }
    try {
        const [result] = await pool.query(`INSERT INTO anggota (nama, alamat, no_telepon, tanggal_bergabung, status) VALUES (?, ?, ?, CURDATE(), 'Aktif')`, [nama, alamat, no_telepon]);
        logToFile(`Anggota baru berhasil terdaftar. ID: ${result.insertId}`);
        res.status(201).json({ success: true, message: 'Anggota berhasil didaftarkan!', memberId: result.insertId });
    } catch (err) {
        logToFile(`Error saat menyimpan data: ${err}`);
        return res.status(500).json({ success: false, message: 'Gagal mendaftar anggota.', error: err.message });
    }
});

app.get('/api/check-member', async (req, res) => {
    logToFile('API /api/check-member dipanggil.');
    const nama = req.query.nama;
    if (!nama) {
        return res.status(400).json({ success: false, message: 'Nama tidak boleh kosong.' });
    }
    try {
        const [rows] = await pool.query(`SELECT COUNT(*) AS count FROM anggota WHERE nama = ? AND status = 'Aktif'`, [nama]);
        const memberExists = rows[0].count > 0;
        logToFile(`Hasil pengecekan: ${JSON.stringify({ nama, exists: memberExists })}`);
        if (memberExists) {
            return res.status(200).json({ exists: true, message: 'Anda sudah terdaftar sebagai anggota aktif.' });
        } else {
            return res.status(200).json({ exists: false, message: 'Nama tersedia untuk pendaftaran.' });
        }
    } catch (err) {
        logToFile(`❌ Error fatal saat memeriksa anggota: ${err}`);
        return res.status(500).json({ success: false, message: 'Gagal memeriksa anggota.', detail: err.message });
    }
});

// --- MENJALANKAN SERVER ---
app.listen(port, () => {
    console.log(`Server berjalan di http://localhost:${port}`);
});