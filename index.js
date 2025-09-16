const express = require('express');
const mysql = require('mysql2/promise');
const bodyParser = require('body-parser');
const moment = require('moment-timezone');
const crypto = require('crypto');
const app = express();
const axios = require('axios');
const port = 3000;

// --- Impor dan gunakan package cors ---
const cors = require('cors');
app.use(cors());

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

db.getConnection((err, connection) => {
    if (err) {
        console.error('❌ Gagal koneksi ke database:', err.message);
        if (err.code === 'PROTOCOL_CONNECTION_LOST') {
            console.error('Koneksi database terputus. Pastikan server database berjalan.');
        } else if (err.code === 'ER_CON_COUNT_ERROR') {
            console.error('Terlalu banyak koneksi database.');
        } else if (err.code === 'ECONNREFUSED') {
            console.error('Koneksi ditolak. Pastikan detail host, user, dan password sudah benar.');
        } else {
            console.error('Error koneksi:', err.message);
        }
    }
    if (connection) {
        console.log('✅ Koneksi ke database berhasil!');
        connection.release();
    }
    return;
});

// Middleware untuk mem-parsing body request JSON
app.use(bodyParser.json());

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
    console.log('✅ Menerima permintaan untuk membuat Virtual Account (VA)...');
    try {
        const body = req.body;
        console.log('Data yang diterima:', body);

        // Validasi data yang masuk dari klien
        const { jumlah, keterangan, anggota_id, jenis_simpanan_id, bank_code } = body;
        if (!anggota_id || !jumlah || !jenis_simpanan_id) {
            console.error('Data tidak lengkap: anggota_id, jumlah, atau jenis_simpanan_id tidak ditemukan.');
            return res.status(400).json({
                error: "Data tidak lengkap",
                detail: "Mohon lengkapi semua data yang diperlukan (anggota_id, jumlah, jenis_simpanan_id)."
            });
        }

        // --- Langkah 1: Simpan setoran di tabel `transaksi` ---
        console.log(`Menyimpan transaksi di database untuk anggota ID ${anggota_id}...`);

        const [transaksiResult] = await db.query(
            `INSERT INTO transaksi (anggota_id, jenis_simpanan_id, tanggal_transaksi, jumlah, tipe_transaksi, keterangan) VALUES (?, ?, NOW(), ?, ?, ?)`,
            [anggota_id, jenis_simpanan_id, jumlah, 'SETORAN ONLINE', keterangan]
        );
        const transaksiId = transaksiResult.insertId;
        console.log(`Transaksi berhasil disimpan dengan ID: ${transaksiId}`);

        // --- Langkah 2: Panggil API LinkQu.id ---
        const partner_reff = generatePartnerReff();
        const expired = getExpiredTimestamp();
        const url_callback = "https://kop.siappgo.id/callback";

        const signature = generateSignaturePOST({
            amount: jumlah,
            expired,
            bank_code: bank_code, // Menggunakan bank_code dari body yang sudah divalidasi
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

        const url = 'https://api.linkqu.id/linkqu-partner/transaction/create/va';
        console.log(`Memanggil API LinkQu.id untuk VA...`);
        const response = await axios.post(url, payload, { headers });
        const result = response.data;
        console.log('API LinkQu.id berhasil dipanggil. Respons:', result);

        // --- Langkah 3: Simpan detail pembayaran ke tabel `pembayaran_online` ---
        console.log('Menyimpan detail pembayaran online...');
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
                expired,
                anggota_id,
                JSON.stringify(result)
            ]
        );
        console.log('Detail pembayaran online berhasil disimpan.');

        res.json(result);
    } catch (err) {
        console.error('❌ Gagal membuat VA:', err.message);
        res.status(500).json({
            error: "Gagal membuat VA",
            detail: err.response?.data || err.message
        });
    }
});



app.post('/create-qris', async (req, res) => {
    console.log('✅ Menerima permintaan untuk membuat QRIS...');
    try {
        const body = req.body;
        console.log('Data yang diterima:', body);

        // Validasi data yang masuk dari klien
        const { jumlah, keterangan, anggota_id, jenis_simpanan_id } = body;
        if (!anggota_id || !jumlah || !jenis_simpanan_id) {
            console.error('Data tidak lengkap: anggota_id, jumlah, atau jenis_simpanan_id tidak ditemukan.');
            return res.status(400).json({
                error: "Data tidak lengkap",
                detail: "Mohon lengkapi semua data yang diperlukan (anggota_id, jumlah, jenis_simpanan_id)."
            });
        }

        // --- Langkah 1: Simpan setoran di tabel `transaksi` ---
        console.log(`Menyimpan transaksi di database untuk anggota ID ${anggota_id}...`);

        const [transaksiResult] = await db.query(
            `INSERT INTO transaksi (anggota_id, jenis_simpanan_id, tanggal_transaksi, jumlah, tipe_transaksi, keterangan) VALUES (?, ?, NOW(), ?, ?, ?)`,
            [anggota_id, jenis_simpanan_id, jumlah, 'SETORAN ONLINE', keterangan]
        );
        const transaksiId = transaksiResult.insertId;
        console.log(`Transaksi berhasil disimpan dengan ID: ${transaksiId}`);

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
        console.log(`Memanggil API LinkQu.id untuk QRIS...`);
        const response = await axios.post(url, payload, { headers });
        const result = response.data;
        console.log('API LinkQu.id berhasil dipanggil. Respons:', result);

        // --- Langkah 3: Simpan detail pembayaran ke tabel `pembayaran_online` ---
        console.log('Menyimpan detail pembayaran online...');
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
        console.log('Detail pembayaran online berhasil disimpan.');

        res.json(result);
    } catch (err) {
        console.error(`❌ Gagal membuat QRIS: ${err.message}`);
        res.status(500).json({
            error: "Gagal membuat QRIS",
            detail: err.response?.data || err.message
        });
    }
});


// Endpoint callback
app.post("/callback", async (req, res) => {
    console.log(`✅ Callback diterima: ${JSON.stringify(req.body)}`);

    // Dapatkan koneksi transaksi dari pool
    const connection = await pool.getConnection();

    try {
        const { partner_reff } = req.body;

        // Mulai transaksi
        await connection.beginTransaction();

        // 1. Ambil status pembayaran saat ini
        const [statusRows] = await connection.query(
            `SELECT status_pembayaran FROM pembayaran_online WHERE partner_reff = ? LIMIT 1`,
            [partner_reff]
        );

        if (statusRows.length > 0 && statusRows[0].status_pembayaran === 'SUKSES') {
            console.log(`ℹ️ Transaksi ${partner_reff} sudah SUKSES sebelumnya. Tidak diproses ulang.`);
            await connection.commit();
            connection.release(); // Lepaskan koneksi
            return res.status(200).json({
                message: "Transaksi sudah SUKSES sebelumnya. Tidak diproses ulang."
            });
        }

        // 2. Periksa status pembayaran dari body callback
        const paymentStatusFromCallback = req.body.status;
        if (paymentStatusFromCallback === 'SUCCESS') {

            // 3. Ambil jumlah dan anggota_id dari tabel transaksi dan pembayaran_online
            const [dataRows] = await connection.query(
                `SELECT
                    t.jumlah,
                    t.anggota_id
                FROM pembayaran_online AS po
                JOIN transaksi AS t ON po.transaksi_id = t.id
                WHERE po.partner_reff = ?
                LIMIT 1`,
                [partner_reff]
            );

            if (dataRows.length === 0) {
                console.error(`❌ Data transaksi tidak ditemukan untuk Partner Reff: ${partner_reff}.`);
                await connection.rollback();
                connection.release();
                return res.status(404).json({ error: "Data transaksi tidak ditemukan." });
            }

            const { jumlah, anggota_id } = dataRows[0];

            // 4. Perbarui saldo anggota
            await connection.query(
                `UPDATE anggota SET saldo = saldo + ? WHERE id = ?`,
                [jumlah, anggota_id]
            );
            console.log(`✅ Saldo anggota ID ${anggota_id} berhasil ditambahkan sejumlah ${jumlah}.`);

            // 5. Perbarui status pembayaran
            await connection.query(
                `UPDATE pembayaran_online SET status_pembayaran = 'SUKSES' WHERE partner_reff = ?`,
                [partner_reff]
            );
            console.log(`✅ Status pembayaran untuk Partner Reff ${partner_reff} berhasil diperbarui menjadi SUKSES.`);

            // Commit transaksi
            await connection.commit();
            console.log(`✅ Transaksi ${partner_reff} selesai diproses.`);
            res.status(200).json({ message: "Callback diterima dan saldo ditambahkan" });

        } else {
            console.log(`ℹ️ Callback untuk transaksi ${partner_reff} diterima, tetapi statusnya bukan SUCCESS. Tidak ada perubahan.`);
            res.status(200).json({ message: "Callback diterima, tetapi pembayaran belum SUKSES" });
            await connection.rollback(); // Rollback jika status tidak SUKSES
        }

    } catch (err) {
        await connection.rollback();
        console.error(`❌ Gagal memproses callback: ${err.message}`);
        res.status(500).json({
            error: "Gagal memproses callback",
            detail: err.message
        });
    } finally {
        if (connection) connection.release();
    }
});

// Endpoint untuk mendaftarkan anggota baru
app.get('/api/member-details', async (req, res) => {
    console.log('API /api/member-details dipanggil.');
    console.log('Query yang diterima:', req.query);

    const { nama } = req.query;

    if (!nama) {
        console.error('Error: Nama anggota pada query kosong. Mengirim status 400.');
        return res.status(400).json({ success: false, message: 'Nama anggota tidak boleh kosong.' });
    }

    try {
        const sql = `SELECT * FROM anggota WHERE nama = ?`;
        console.log('Menjalankan query:', sql);

        const [rows] = await db.query(sql, [nama]);

        if (rows.length === 0) {
            console.warn('Anggota tidak ditemukan:', nama);
            return res.status(404).json({ success: false, message: 'Anggota tidak ditemukan.' });
        }

        console.log('Detail anggota ditemukan. Mengirim data:', rows[0]);
        res.status(200).json({ success: true, data: rows[0] });

    } catch (err) {
        console.error('Error saat mengambil detail anggota:', err);
        return res.status(500).json({ success: false, message: 'Gagal mengambil data anggota.', error: err.message });
    }
});

// Endpoint untuk mendaftarkan anggota baru (menggunakan async/await)
app.post('/api/register-member', async (req, res) => {
    console.log('API /api/register-member dipanggil.');
    console.log('Data yang diterima:', req.body);

    const { nama, alamat, no_telepon } = req.body;

    if (!nama) {
        console.error('Error: Nama tidak diisi. Mengirim status 400.');
        return res.status(400).json({ success: false, message: 'Nama harus diisi.' });
    }

    try {
        const sql = `INSERT INTO anggota (nama, alamat, no_telepon, tanggal_bergabung, status) VALUES (?, ?, ?, CURDATE(), 'Aktif')`;

        const [result] = await db.query(sql, [nama, alamat, no_telepon]);

        console.log('Anggota baru berhasil terdaftar. ID:', result.insertId);
        res.status(201).json({ success: true, message: 'Anggota berhasil didaftarkan!', memberId: result.insertId });

    } catch (err) {
        console.error('Error saat menyimpan data:', err);
        return res.status(500).json({ success: false, message: 'Gagal mendaftar anggota.', error: err.message });
    }
});
// Endpoint untuk memeriksa keberadaan anggota
// Endpoint untuk memeriksa keberadaan anggota (menggunakan async/await)
app.get('/api/check-member', async (req, res) => {
    console.log('API /api/check-member dipanggil.');
    console.log('Query yang diterima:', req.query);

    const nama = req.query.nama;

    if (!nama) {
        return res.status(400).json({ success: false, message: 'Nama tidak boleh kosong.' });
    }

    try {
        const sql = `SELECT COUNT(*) AS count FROM anggota WHERE nama = ? AND status = 'Aktif'`;
        console.log('Menjalankan query:', sql);

        // Menggunakan sintaks async/await yang lebih andal
        const [rows] = await db.query(sql, [nama]);

        // --- BARIS PENTING INI ---
        console.log('Hasil mentah dari query database:', rows);
        // --- AKHIR BARIS PENTING ---

        const memberExists = rows[0].count > 0;
        console.log('Hasil pengecekan:', { nama, exists: memberExists });

        if (memberExists) {
            return res.status(200).json({ exists: true, message: 'Anda sudah terdaftar sebagai anggota aktif.' });
        } else {
            return res.status(200).json({ exists: false, message: 'Nama tersedia untuk pendaftaran.' });
        }

    } catch (err) {
        // Ini akan menangkap error koneksi, query, atau timeout
        console.error('❌ Error fatal saat memeriksa anggota:', err);
        return res.status(500).json({ success: false, message: 'Gagal memeriksa anggota.', detail: err.message });
    }
});
// Endpoint untuk mendapatkan detail anggota
app.get('/api/member-details', (req, res) => {
    // Logging: Catat permintaan masuk
    console.log('API /api/member-details dipanggil.');
    console.log('Query yang diterima:', req.query);

    const { nama } = req.query;

    if (!nama) {
        // Logging: Catat respons error
        console.error('Error: Nama anggota pada query kosong. Mengirim status 400.');
        return res.status(400).json({ success: false, message: 'Nama anggota tidak boleh kosong.' });
    }

    const sql = `SELECT * FROM anggota WHERE nama = ?`;
    // Logging: Tampilkan query SQL
    console.log('Menjalankan query:', sql);

    db.query(sql, [nama], (err, result) => {
        if (err) {
            // Logging: Catat error dari database
            console.error('Error saat mengambil detail anggota:', err);
            return res.status(500).json({ success: false, message: 'Gagal mengambil data anggota.', error: err.message });
        }

        if (result.length === 0) {
            // Logging: Catat respons 'tidak ditemukan'
            console.warn('Anggota tidak ditemukan:', nama);
            return res.status(404).json({ success: false, message: 'Anggota tidak ditemukan.' });
        }

        // Logging: Catat respons sukses
        console.log('Detail anggota ditemukan. Mengirim data:', result[0]);
        res.status(200).json({ success: true, data: result[0] });
    });
});




// Jalankan server
app.listen(port, () => {
    console.log(`Server berjalan di http://localhost:${port}`);
});