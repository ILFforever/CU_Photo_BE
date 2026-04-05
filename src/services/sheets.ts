import { Photo } from '../types';

// Converts a Google Sheets share URL or edit URL to a CSV export URL
function toCsvUrl(sheetUrl: string): string {
  // Extract spreadsheet ID and gid
  const idMatch = sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
  const gidMatch = sheetUrl.match(/[#&?]gid=(\d+)/);

  if (!idMatch) throw new Error('Invalid Google Sheets URL');

  const id = idMatch[1];
  const gid = gidMatch ? gidMatch[1] : null;

  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ''}`;
}

function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  for (const line of csv.trim().split('\n')) {
    const cells: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { current += '"'; i++; } // escaped quote
        else inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        cells.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    cells.push(current.trim());
    rows.push(cells);
  }
  return rows;
}

// Columns from the Google Form CSV:
//   Timestamp | Email Address | ชื่อ - นามสกุล | ชื่อเล่น | กลุ่ม | มหาวิทยาลัย | ส่งภาพ | อธิบายภาพ
export async function fetchPhotosFromSheet(sheetUrl: string): Promise<Omit<Photo, 'id' | 'voteCount'>[]> {
  const csvUrl = toCsvUrl(sheetUrl);

  console.log('[sheets] fetching:', csvUrl);
  const res = await fetch(csvUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; cu-photo-be/1.0)' },
  });
  console.log('[sheets] response status:', res.status);
  if (!res.ok) {
    const body = await res.text();
    console.log('[sheets] response body:', body.slice(0, 300));
    throw new Error(`Failed to fetch sheet: ${res.status}`);
  }

  const text = await res.text();
  const rows = parseCsv(text);

  if (rows.length < 2) throw new Error('Sheet has no data rows');

  const headers = rows[0];
  const idx = (keyword: string) =>
    headers.findIndex((h) => h.includes(keyword));

  const imageUrlIdx   = idx('ส่งภาพ');
  const titleIdx      = idx('อธิบายภาพ');
  const submittedByIdx = idx('ชื่อ');
  const nicknameIdx   = idx('ชื่อเล่น');

  if (imageUrlIdx === -1) throw new Error('Cannot find image URL column (ส่งภาพ)');
  if (titleIdx === -1)    throw new Error('Cannot find description column (อธิบายภาพ)');

  return rows.slice(1)
    .filter((row) => row[imageUrlIdx]?.trim())
    .map((row) => ({
      title: row[titleIdx]?.trim() || '',
      imageUrl: convertDriveUrl(row[imageUrlIdx].trim()),
      submittedBy: nicknameIdx !== -1
        ? row[nicknameIdx]?.trim() || row[submittedByIdx]?.trim() || ''
        : row[submittedByIdx]?.trim() || '',
    }));
}

// Convert Google Drive share URLs to a CORS-friendly thumbnail link
function convertDriveUrl(url: string): string {
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/id=([a-zA-Z0-9_-]+)/);
  if (match) return `https://drive.google.com/thumbnail?id=${match[1]}&sz=w1200`;
  return url;
}
