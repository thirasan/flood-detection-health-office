// ใช้เฉพาะข้อมูลจาก GISTDA (ต้องมี API key)
// อิงตามเอกสาร https://disaster.gistda.or.th/services/open-api#get_features_flood_7day
// รูปแบบ (open endpoint มี redirect + ใช้ cookie): https://disaster.gistda.or.th/services/get_features_flood_7day?token={API_KEY}&bbox={MINX},{MINY},{MAXX},{MAXY}&format=geojson
// หากโดน 307/CORS ให้ลอง gateway ที่รองรับ apikey แบบ query (หลีกเลี่ยง preflight header)

const hatyaiBBox = {
  minX: 100.3,
  minY: 6.8,
  maxX: 100.65,
  maxY: 7.2
};

window.appConfig = {
  backendBaseUrl: 'http://localhost:4000',
  gistda: {
    enabled: false, // ปิดการเรียกตรง GISTDA ในฝั่งเว็บ ให้เรียกผ่าน backend เท่านั้น
    apiKey: '',
    urlTemplate: '',
    gatewayUrlTemplate: '',
    bbox: hatyaiBBox
  },
  // ใช้ไฟล์สถานพยาบาลใหม่ hospital.json เป็นแหล่งหลัก
  facilitySourceUrl: './data/hospital.json',
  fallbackFloodUrl: './data/flood.geojson',
  fallbackFacilityUrl: './data/hospital.json'
};
