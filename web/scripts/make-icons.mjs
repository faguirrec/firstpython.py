/**
 * Genera los iconos PNG de la PWA sin dependencias externas.
 *   node scripts/make-icons.mjs
 *
 * iOS exige un PNG real para `apple-touch-icon` (no acepta SVG), así que los
 * iconos se rasterizan aquí y quedan versionados en public/icons/.
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/icons');
const BG = [42, 120, 214];      // azul serie-1
const INK = [252, 252, 251];    // superficie clara

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y += 1) {
    raw[o] = 0; // filtro "none"
    o += 1;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixel(x / size, y / size);
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
      o += 4;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * La marca: un techo y, debajo, dos columnas de distinta altura. Un hogar y dos
 * aportes proporcionales, que es exactamente lo que hace la app.
 * Debe coincidir con el componente Logo de src/components/Icons.tsx.
 */
function house(u, v) {
  // Techo: banda diagonal de grosor constante formando una uve invertida.
  const distanciaAlTecho = Math.abs(v - (0.24 + Math.abs(u - 0.5) * 0.82));
  const techo = distanciaAlTecho < 0.038 && u > 0.17 && u < 0.83 && v > 0.19 && v < 0.5;

  // Columna izquierda, más baja.
  const izquierda = u >= 0.33 && u <= 0.455 && v >= 0.56 && v <= 0.79;
  // Columna derecha, más alta.
  const derecha = u >= 0.545 && u <= 0.67 && v >= 0.47 && v <= 0.79;
  // Suelo.
  const suelo = v >= 0.79 && v <= 0.825 && u >= 0.25 && u <= 0.75;

  return techo || izquierda || derecha || suelo;
}

function render(size, { rounded }) {
  return encodePng(size, (u, v) => {
    if (rounded) {
      // Esquinas redondeadas para el icono normal; el maskable va a sangre.
      const r = 0.22;
      const dx = Math.max(r - u, u - (1 - r), 0);
      const dy = Math.max(r - v, v - (1 - r), 0);
      if (Math.hypot(dx, dy) > r) return [0, 0, 0, 0];
    }
    // El maskable necesita margen: iOS/Android recortan hasta un 20%.
    const scale = rounded ? 1 : 0.78;
    const cu = (u - 0.5) / scale + 0.5;
    const cv = (v - 0.5) / scale + 0.5;
    return house(cu, cv) ? [...INK, 255] : [...BG, 255];
  });
}

fs.mkdirSync(OUT, { recursive: true });
const files = [
  ['icon-192.png', 192, { rounded: true }],
  ['icon-512.png', 512, { rounded: true }],
  ['icon-maskable-512.png', 512, { rounded: false }],
  ['apple-touch-icon.png', 180, { rounded: false }], // iOS pone su propia máscara
];

for (const [name, size, opts] of files) {
  fs.writeFileSync(path.join(OUT, name), render(size, opts));
  console.log(`${name} (${size}×${size})`);
}
