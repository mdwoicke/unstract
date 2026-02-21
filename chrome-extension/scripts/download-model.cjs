/**
 * Downloads the all-MiniLM-L6-v2 ONNX model from Hugging Face.
 * Files are saved to public/models/Xenova/all-MiniLM-L6-v2/
 * Run: node scripts/download-model.cjs
 */

const https = require('https')
const http = require('http')
const fs = require('fs')
const path = require('path')
const { URL } = require('url')

const BASE_HF = 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main'
const OUT_DIR = path.join(__dirname, '../public/models/Xenova/all-MiniLM-L6-v2')

const FILES = [
  'tokenizer.json',
  'tokenizer_config.json',
  'config.json',
  'onnx/model_quantized.onnx',
]

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const file = fs.createWriteStream(dest)

    function request(url) {
      const parsedUrl = new URL(url)
      const lib = parsedUrl.protocol === 'https:' ? https : http

      lib.get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          file.close()
          return request(res.headers.location)
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`))
          return
        }
        const total = parseInt(res.headers['content-length'] || '0', 10)
        let downloaded = 0
        res.on('data', (chunk) => {
          downloaded += chunk.length
          if (total) {
            const pct = Math.round((downloaded / total) * 100)
            process.stdout.write(`\r  ${path.basename(dest)}: ${pct}%`)
          }
        })
        res.pipe(file)
        file.on('finish', () => {
          file.close()
          process.stdout.write('\n')
          resolve()
        })
      }).on('error', reject)
    }

    request(url)
  })
}

async function main() {
  console.log(`Downloading all-MiniLM-L6-v2 model to: ${OUT_DIR}`)
  for (const file of FILES) {
    const url = `${BASE_HF}/${file}`
    const dest = path.join(OUT_DIR, file)
    if (fs.existsSync(dest)) {
      console.log(`  Skipping ${file} (already exists)`)
      continue
    }
    console.log(`  Downloading ${file}...`)
    await downloadFile(url, dest)
  }
  console.log('\nModel downloaded successfully.')
  console.log('Now run: npm run build')
}

main().catch((err) => {
  console.error('Download failed:', err.message)
  process.exit(1)
})
