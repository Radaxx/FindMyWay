// Génération et téléchargement d'un fichier GPX 1.1.

const escapeXml = (s) =>
  String(s).replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c])
  );

/**
 * @param {{lat:number,lng:number}[]} coords
 * @param {{name?: string, elevations?: number[]}} [options]
 * @returns {string} contenu GPX
 */
export function buildGpx(coords, { name = 'Itinéraire FindMyWay', elevations } = {}) {
  const time = new Date().toISOString();

  const points = coords
    .map((p, i) => {
      const ele =
        elevations && Number.isFinite(elevations[i])
          ? `<ele>${elevations[i].toFixed(1)}</ele>`
          : '';
      return `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}">${ele}</trkpt>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="FindMyWay"
     xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${escapeXml(name)}</name>
    <time>${time}</time>
  </metadata>
  <trk>
    <name>${escapeXml(name)}</name>
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>
`;
}

/** Déclenche le téléchargement du GPX dans le navigateur. */
export function downloadGpx(content, filename) {
  const blob = new Blob([content], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Nom de fichier lisible : findmyway-velo-30km-2026-07-27.gpx */
export function gpxFilename(sportLabel, distanceMeters) {
  const date = new Date().toISOString().slice(0, 10);
  const km = (distanceMeters / 1000).toFixed(1).replace('.0', '').replace('.', '-');
  const slug = sportLabel
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  return `findmyway-${slug}-${km}km-${date}.gpx`;
}
