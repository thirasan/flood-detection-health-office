// ข้อมูลสำรองในตัว (ใช้เมื่อดึงข้อมูลจริง/ไฟล์ไม่สำเร็จ)
window.fallbackData = {
  flood: {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          name: 'น้ำท่วมตัวเมือง (สำรองในตัว)',
          source: 'inline fallback'
        },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [100.4685, 7.0085],
              [100.487, 7.0095],
              [100.4975, 6.9975],
              [100.486, 6.984],
              [100.4705, 6.989],
              [100.4685, 7.0085]
            ]
          ]
        }
      },
      {
        type: 'Feature',
        properties: {
          name: 'น้ำท่วมพื้นที่ (สำรองในตัว)',
          source: 'inline fallback'
        },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [100.517, 7.018],
              [100.534, 7.016],
              [100.5375, 7.0005],
              [100.5205, 6.9985],
              [100.517, 7.018]
            ]
          ]
        }
      }
    ]
  },
  facilities: [
    { id: 'hdya-001', name_th: 'โรงพยาบาลหาดใหญ่', type: 'โรงพยาบาล', lat: 7.0028, lng: 100.474 },
    { id: 'hdya-002', name_th: 'โรงพยาบาลสงขลานครินทร์ (มอ.)', type: 'โรงพยาบาลมหาวิทยาลัย', lat: 7.0085, lng: 100.4978 },
    { id: 'hdya-003', name_th: 'โรงพยาบาลกรุงเทพหาดใหญ่', type: 'โรงพยาบาลเอกชน', lat: 7.0056, lng: 100.4839 },
    { id: 'hdya-004', name_th: 'โรงพยาบาลราษฎร์ยินดี', type: 'โรงพยาบาลเอกชน', lat: 6.999, lng: 100.498 },
    { id: 'hdya-005', name_th: 'รพ.สต.ควนลัง', type: 'รพ.สต.', lat: 7.007, lng: 100.525 },
    { id: 'hdya-006', name_th: 'คลินิกหมอจุฬา', type: 'คลินิกเวชกรรม', lat: 6.9995, lng: 100.47 },
    { id: 'hdya-007', name_th: 'คลินิกเวชกรรมดร.สมชาย', type: 'คลินิกเวชกรรม', lat: 7.022, lng: 100.468 },
    { id: 'hdya-008', name_th: 'รพ.สต.คอหงส์', type: 'รพ.สต.', lat: 7.0115, lng: 100.46 }
  ]
};
