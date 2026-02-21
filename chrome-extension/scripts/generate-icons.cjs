/**
 * Generates Chrome extension icons by resizing the source logo.
 * Uses sharp for high-quality PNG resizing.
 */

const sharp = require('sharp')
const fs = require('fs')
const path = require('path')

const SOURCE = path.resolve(__dirname, '../../unstract-V2/mbn.png')
// Fallback: check a few common locations
const FALLBACKS = [
  path.resolve(__dirname, '../source-icon.png'),
  path.resolve(__dirname, '../../mbn.png'),
]

const iconsDir = path.join(__dirname, '../public/icons')
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true })

const sizes = [16, 32, 48, 128]

async function generate() {
  // Find source image
  let src = SOURCE
  if (!fs.existsSync(src)) {
    for (const fb of FALLBACKS) {
      if (fs.existsSync(fb)) { src = fb; break }
    }
  }
  if (!fs.existsSync(src)) {
    console.error(`Source icon not found at ${SOURCE}`)
    console.error('Copy your logo to chrome-extension/source-icon.png')
    process.exit(1)
  }

  console.log(`Using source: ${src}`)

  for (const size of sizes) {
    const outPath = path.join(iconsDir, `icon${size}.png`)
    await sharp(src)
      .resize(size, size, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
      .png()
      .toFile(outPath)
    const stat = fs.statSync(outPath)
    console.log(`Generated ${outPath} (${stat.size} bytes)`)
  }
  console.log('Icons generated successfully.')
}

generate().catch(err => {
  console.error('Icon generation failed:', err)
  process.exit(1)
})
