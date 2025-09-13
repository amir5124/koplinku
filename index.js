const express = require('express');
const mysql = require('mysql2/promise');
const bodyParser = require('body-parser');
const moment = require('moment-timezone');
const crypto = require('crypto');
const app = express();
const port = 3000;

// Konfigurasi koneksi database
const db = mysql.createPool({
    host: 'linku.co.id',
    user: 'linkucoi_koplinku', // Ganti dengan user database Anda
    password: '~5m1,Nzg-3vn', // Ganti dengan password database Anda
    database: 'linkucoi_koplinku', // Ganti dengan nama database Anda
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Middleware untuk mem-parsing body request JSON
app.use(bodyParser.json());

// Middleware untuk mengizinkan CORS (penting untuk frontend)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

const clientId = "5f5aa496-7e16-4ca1-9967-33c768dac6c7";
const clientSecret = "TM1rVhfaFm5YJxKruHo0nWMWC";
const username = "LI9019VKS";
const pin = "5m6uYAScSxQtCmU";
const serverKey = "QtwGEr997XDcmMb1Pq8S5X1N";

// 📝 Fungsi untuk menulis log ke stderr.log
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

// 🔄 Fungsi expired format YYYYMMDDHHmmss
function getExpiredTimestamp(minutesFromNow = 15) {
    return moment.tz('Asia/Jakarta').add(minutesFromNow, 'minutes').format('YYYYMMDDHHmmss');
}


// 🔐 Fungsi membuat signature untuk request POST VA
function generateSignaturePOST({
    amount,
    expired,
    bank_code,
    partner_reff,
    customer_id,
    customer_name,
    customer_email,
    clientId,
    serverKey
}) {
    const path = '/transaction/create/va';
    const method = 'POST';

    const rawValue = amount + expired + bank_code + partner_reff +
        customer_id + customer_name + customer_email + clientId;
    const cleaned = rawValue.replace(/[^0-9a-zA-Z]/g, "").toLowerCase();

    const signToString = path + method + cleaned;

    return crypto.createHmac("sha256", serverKey).update(signToString).digest("hex");
}

function generateSignatureQRIS({
    amount,
    expired,
    partner_reff,
    customer_id,
    customer_name,
    customer_email,
    clientId,
    serverKey
}) {
    const path = '/transaction/create/qris';
    const method = 'POST';

    const rawValue = amount + expired + partner_reff +
        customer_id + customer_name + customer_email + clientId;
    const cleaned = rawValue.replace(/[^0-9a-zA-Z]/g, "").toLowerCase();

    const signToString = path + method + cleaned;

    return crypto.createHmac("sha256", serverKey).update(signToString).digest("hex");
}

// 🧾 Fungsi membuat kode unik partner_reff
function generatePartnerReff() {
    const prefix = 'INV-782372373627';
    const timestamp = Date.now();
    const randomStr = crypto.randomBytes(4).toString('hex');
    return `${prefix}-${timestamp}-${randomStr}`;
}

// ✅ Endpoint POST untuk membuat VA
// ✅ Endpoint POST untuk membuat VA
app.post('/create-va', async (req, res) => {
    try {
        const body = req.body;

        // --- Langkah 1: Simpan setoran di tabel `transaksi` ---
        // Asumsikan data yang dikirim dari frontend adalah: jumlah, keterangan, anggota_id, jenis_simpanan_id
        const { jumlah, keterangan, anggota_id, jenis_simpanan_id } = body;

        const [transaksiResult] = await db.query(
            `INSERT INTO transaksi (anggota_id, jenis_simpanan_id, tanggal_transaksi, jumlah, tipe_transaksi, keterangan) VALUES (?, ?, NOW(), ?, ?, ?)`,
            [anggota_id, jenis_simpanan_id, jumlah, 'SETORAN ONLINE', keterangan]
        );
        const transaksiId = transaksiResult.insertId; // Dapatkan ID transaksi yang baru dibuat

        // --- Langkah 2: Panggil API LinkQu.id ---
        const partner_reff = generatePartnerReff();
        const expired = getExpiredTimestamp();
        const url_callback = "https://kop.siappgo.id/callback";

        const signature = generateSignaturePOST({
            amount: jumlah, // Gunakan jumlah dari body
            expired,
            bank_code: body.bank_code,
            partner_reff,
            customer_id: anggota_id,
            customer_name: body.customer_name,
            customer_email: body.customer_email,
            clientId,
            serverKey
        });

        const payload = {
            ...body,
            partner_reff,
            username,
            pin,
            expired,
            signature,
            url_callback,
            // Perlu disesuaikan jika API LinkQu.id butuh nama field berbeda
            amount: jumlah,
            customer_id: anggota_id,
            customer_name: body.customer_name,
            customer_email: body.customer_email
        };

        const headers = {
            'client-id': clientId,
            'client-secret': clientSecret
        };

        const url = 'https://api.linkqu.id/linkqu-partner/transaction/create/va';
        const response = await axios.post(url, payload, { headers });
        const result = response.data;

        // --- Langkah 3: Simpan detail pembayaran ke tabel `pembayaran_online` ---
        await db.query(
            `INSERT INTO pembayaran_online (
                transaksi_id, partner_reff, jumlah, jenis_pembayaran, va_number,
                status_pembayaran, expired_at, customer_id, raw_response
            ) VALUES (?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?), ?, ?)`,
            [
                transaksiId,
                partner_reff,
                result.amount,
                'VA',
                result.virtual_account,
                'PENDING',
                expired, // `FROM_UNIXTIME` akan mengonversi timestamp
                anggota_id,
                JSON.stringify(result) // Simpan respons lengkap dalam format JSON
            ]
        );

        res.json(result);
    } catch (err) {
        console.error('❌ Gagal membuat VA:', err.message);
        res.status(500).json({
            error: "Gagal membuat VA",
            detail: err.response?.data || err.message
        });
    }
});


// ✅ Endpoint POST untuk membuat QRIS
app.post('/create-qris', async (req, res) => {
    try {
        const body = req.body;

        // --- Langkah 1: Simpan setoran di tabel `transaksi` ---
        const { jumlah, keterangan, anggota_id, jenis_simpanan_id } = body;

        const [transaksiResult] = await db.query(
            `INSERT INTO transaksi (anggota_id, jenis_simpanan_id, tanggal_transaksi, jumlah, tipe_transaksi, keterangan) VALUES (?, ?, NOW(), ?, ?, ?)`,
            [anggota_id, jenis_simpanan_id, jumlah, 'SETORAN ONLINE', keterangan]
        );
        const transaksiId = transaksiResult.insertId;

        // --- Langkah 2: Panggil API LinkQu.id ---
        const partner_reff = generatePartnerReff();
        const expired = getExpiredTimestamp();
        const url_callback = "https://kop.siappgo.id/callback";

        const signature = generateSignatureQRIS({
            amount: jumlah,
            expired,
            partner_reff,
            customer_id: anggota_id,
            customer_name: body.customer_name,
            customer_email: body.customer_email,
            clientId,
            serverKey
        });

        const payload = {
            ...body,
            partner_reff,
            username,
            pin,
            expired,
            signature,
            url_callback,
            amount: jumlah,
            customer_id: anggota_id,
            customer_name: body.customer_name,
            customer_email: body.customer_email
        };

        const headers = {
            'client-id': clientId,
            'client-secret': clientSecret
        };

        const url = 'https://api.linkqu.id/linkqu-partner/transaction/create/qris';
        const response = await axios.post(url, payload, { headers });
        const result = response.data;

        // --- Langkah 3: Simpan detail pembayaran ke tabel `pembayaran_online` ---
        await db.query(
            `INSERT INTO pembayaran_online (
                transaksi_id, partner_reff, jumlah, jenis_pembayaran, qris_url,
                status_pembayaran, expired_at, customer_id, raw_response
            ) VALUES (?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?), ?, ?)`,
            [
                transaksiId,
                partner_reff,
                result.amount,
                'QRIS',
                result.imageqris,
                'PENDING',
                expired,
                anggota_id,
                JSON.stringify(result)
            ]
        );

        res.json(result);
    } catch (err) {
        console.error(`❌ Gagal membuat QRIS: ${err.message}`);
        res.status(500).json({
            error: "Gagal membuat QRIS",
            detail: err.response?.data || err.message
        });
    }
});

// Endpoint untuk pendaftaran anggota (metode POST)
app.post('/api/register-member', (req, res) => {
    // Ambil data dari body request
    const { nama, alamat, no_telepon } = req.body;

    // Validasi sederhana: pastikan nama tidak kosong
    if (!nama) {
        return res.status(400).json({ success: false, message: 'Nama harus diisi.' });
    }

    const sql = `INSERT INTO anggota (nama, alamat, no_telepon, tanggal_bergabung) VALUES (?, ?, ?, CURDATE())`;

    // Jalankan query SQL
    db.query(sql, [nama, alamat, no_telepon], (err, result) => {
        if (err) {
            console.error('Error saat menyimpan data:', err);
            return res.status(500).json({ success: false, message: 'Gagal mendaftar anggota.', error: err.message });
        }

        console.log('Anggota baru berhasil terdaftar:', result.insertId);
        res.status(201).json({ success: true, message: 'Anggota berhasil didaftarkan!', memberId: result.insertId });
    });
});

app.get('/api/check-member', (req, res) => {
    const nama = req.query.nama;

    if (!nama) {
        return res.status(400).json({ success: false, message: 'Nama tidak boleh kosong.' });
    }

    const sql = `SELECT COUNT(*) AS count FROM anggota WHERE nama = ? AND status = 'Aktif'`;

    db.query(sql, [nama], (err, result) => {
        if (err) {
            console.error('Error saat memeriksa anggota:', err);
            return res.status(500).json({ success: false, message: 'Gagal memeriksa anggota.' });
        }

        const memberExists = result[0].count > 0;
        if (memberExists) {
            return res.status(200).json({ exists: true, message: 'Anda sudah terdaftar sebagai anggota aktif.' });
        } else {
            return res.status(200).json({ exists: false, message: 'Nama tersedia untuk pendaftaran.' });
        }
    });
});

app.get('/api/member-details', (req, res) => {
    const { nama } = req.query;

    if (!nama) {
        return res.status(400).json({ success: false, message: 'Nama anggota tidak boleh kosong.' });
    }

    const sql = `SELECT * FROM anggota WHERE nama = ?`;

    db.query(sql, [nama], (err, result) => {
        if (err) {
            console.error('Error saat mengambil detail anggota:', err);
            return res.status(500).json({ success: false, message: 'Gagal mengambil data anggota.', error: err.message });
        }

        if (result.length === 0) {
            return res.status(404).json({ success: false, message: 'Anggota tidak ditemukan.' });
        }

        // Kirim data anggota yang ditemukan
        res.status(200).json({ success: true, data: result[0] });
    });
});


// Jalankan server
app.listen(port, () => {
    console.log(`Server berjalan di http://localhost:${port}`);
});