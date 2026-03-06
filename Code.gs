// ==========================================
// การตั้งค่าพื้นฐาน (Configuration)
// ==========================================
const scriptProps = PropertiesService.getScriptProperties();
const SHEET_ID = scriptProps.getProperty('SHEET_ID');
const FOLDER_ID = scriptProps.getProperty('FOLDER_ID');
const LINE_CHANNEL_ACCESS_TOKEN = scriptProps.getProperty('LINE_CHANNEL_ACCESS_TOKEN'); // สำหรับ Messaging API

// ==========================================
// 1. ระบบจัดการหน้าเว็บ (Routing & Rendering)
// ==========================================
function doGet(e) {
  const role = checkUserAccess();
  
  // ถ้าไม่มีสิทธิ์เลย ให้แสดงหน้าแจ้งเตือน
  if (role === 'None') {
    return HtmlService.createHtmlOutput('<h2 style="text-align:center; margin-top:50px; font-family:sans-serif;">Access Denied: คุณไม่มีสิทธิ์เข้าใช้งานระบบร้านวันวาฬ</h2>');
  }

  // กำหนดหน้าที่จะแสดง (Staff บังคับให้ดูได้แค่ form)
  let page = e.parameter.page || 'dashboard';
  if (role === 'Staff') {
    page = 'form';
  }

  const template = HtmlService.createTemplateFromFile('Index');
  template.userRole = role;
  template.page = page;
  template.userEmail = Session.getActiveUser().getEmail() || 'ทดสอบใน Editor';

  return template.evaluate()
    .setTitle('ระบบบริหารจัดการร้านวันวาฬ')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ==========================================
// 2. ระบบจัดการสิทธิ์และความปลอดภัย (Security)
// ==========================================
function checkUserAccess() {
  const email = Session.getActiveUser().getEmail();
  
  // กรณีทดสอบรันด้วยตัวเอง (ยังไม่มี email session) ให้เป็น Admin ชั่วคราว
  if (!email) return 'Admin'; 

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName('Users');
  
  if (!sheet) return 'None'; // ถ้ายังไม่สร้างชีต ให้เข้าไม่ได้
  
  const data = sheet.getDataRange().getValues();
  // ข้ามแถวหัวตาราง (เริ่ม i=1) สมมติ Col A = Email, Col B = Role
  for (let i = 1; i < data.length; i++) {
    if (data[i][0].toString().trim().toLowerCase() === email.toLowerCase()) {
      return data[i][1]; // คืนค่า 'Admin', 'Partner', หรือ 'Staff'
    }
  }
  return 'None';
}

// ==========================================
// 3. ระบบบันทึกข้อมูล (Database & File Management)
// ==========================================
function processExpenseForm(formData) {
  // ใช้ LockService ป้องกันข้อมูลทับซ้อนกรณีบันทึกพร้อมกัน
  const lock = LockService.getScriptLock();
  
  try {
    lock.waitLock(10000); // รอสูงสุด 10 วินาที
    
    // ตรวจสอบข้อมูล "Amount" ต้องเป็นตัวเลขและมากกว่า 0
    const amount = parseFloat(formData.amount);
    if (isNaN(amount) || amount <= 0) {
      throw new Error("เกิดข้อผิดพลาด: จำนวนเงินต้องเป็นตัวเลขที่มากกว่า 0 เท่านั้น และห้ามเว้นว่าง");
    }

    // จัดการอัปโหลดไฟล์
    let fileUrl = "";
    if (formData.fileData && formData.fileName) {
      fileUrl = uploadToDrive(formData.fileData, formData.fileName, formData.fileMimeType);
    }

    // บันทึกลง Sheet
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = ss.getSheetByName('Transactions');
    const newId = Utilities.getUuid();
    const timestamp = new Date();
    const email = Session.getActiveUser().getEmail() || 'System';

    // โครงสร้าง: ID, Timestamp, UserEmail, Type (Income/Expense), Category, Amount, Note, ReceiptURL
    sheet.appendRow([
      newId, 
      timestamp, 
      email, 
      formData.type, 
      formData.category, 
      amount, 
      formData.note, 
      fileUrl
    ]);

    return { success: true, message: "บันทึกข้อมูลสำเร็จเรียบร้อย" };
    
  } catch (error) {
    return { success: false, message: error.message };
  } finally {
    lock.releaseLock();
  }
}

function uploadToDrive(base64Data, fileName, mimeType) {
  const folder = DriveApp.getFolderById(FOLDER_ID);
  const data = Utilities.base64Decode(base64Data);
  const blob = Utilities.newBlob(data, mimeType, fileName);
  const file = folder.createFile(blob);
  return file.getWebViewLink(); // คืนค่า URL สำหรับดูไฟล์
}

// ==========================================
// 4. ระบบ Dashboard (Data Processing)
// ==========================================
function getDashboardStats() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const txSheet = ss.getSheetByName('Transactions');
  const setSheet = ss.getSheetByName('Settings');
  
  if(!txSheet) return { error: "ไม่พบแผ่นงาน Transactions" };

  const data = txSheet.getDataRange().getValues();
  const currentMonth = new Date().getMonth();
  const currentYear = new Date().getFullYear();

  let totalIncome = 0;
  let totalExpense = 0;
  let categoryStats = {};

  // คำนวณรายรับ รายจ่าย (เริ่ม i=1 ข้ามหัวตาราง)
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const timestamp = new Date(row[1]);
    
    // กรองเฉพาะเดือนปัจจุบัน
    if (timestamp.getMonth() === currentMonth && timestamp.getFullYear() === currentYear) {
      const type = row[3];
      const category = row[4];
      const amount = parseFloat(row[5]) || 0;

      if (type === 'Income') {
        totalIncome += amount;
      } else if (type === 'Expense') {
        totalExpense += amount;
        // เก็บข้อมูลทำกราฟ
        if (!categoryStats[category]) categoryStats[category] = 0;
        categoryStats[category] += amount;
      }
    }
  }

  const netProfit = totalIncome - totalExpense;

  // ดึงข้อมูลหุ้นส่วนจาก Settings (สมมติ Col A: ชื่อหุ้นส่วน, Col B: เปอร์เซ็นต์ %)
  let partners = [];
  if (setSheet) {
    const setData = setSheet.getDataRange().getValues();
    for (let i = 1; i < setData.length; i++) {
      if(setData[i][0] && setData[i][1]) {
        let percent = parseFloat(setData[i][1]);
        let share = netProfit > 0 ? (netProfit * (percent / 100)) : 0;
        partners.push({
          name: setData[i][0],
          percent: percent,
          share: share
        });
      }
    }
  }

  return {
    income: totalIncome,
    expense: totalExpense,
    netProfit: netProfit,
    categories: Object.keys(categoryStats),
    categoryValues: Object.values(categoryStats),
    partners: partners
  };
}

// ==========================================
// 5. ระบบแจ้งเตือน LINE (Messaging API)
// ==========================================
// 6. ระบบรายงานและจัดการข้อมูล (Report & Management)
// ==========================================

// ดึงข้อมูลทั้งหมดจากชีต Transactions
function getTransactions() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName('Transactions');
  if (!sheet) return [];

  const data = sheet.getDataRange().getValues();
  const result = [];
  
  // วนลูปจากล่างขึ้นบน เพื่อให้ข้อมูลล่าสุดอยู่ด้านบน
  for (let i = data.length - 1; i > 0; i--) {
    const row = data[i];
    if (!row[0]) continue; // ข้ามแถวว่าง
    
    // แก้ปัญหา: แปลง Date เป็น String เพื่อป้องกันบัค GAS คืนค่า Null กลับไปยัง Frontend
    let dateStr = '';
    if (row[1] instanceof Date) {
      dateStr = row[1].toISOString();
    } else if (row[1]) {
      dateStr = new Date(row[1]).toISOString();
    }

    result.push({
      id: row[0],
      date: dateStr, 
      email: row[2],
      type: row[3],
      category: row[4],
      amount: row[5],
      note: row[6],
      receipt: row[7]
    });
  }
  return result;
}

// ลบข้อมูล
function deleteTransaction(id) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = ss.getSheetByName('Transactions');
    const data = sheet.getDataRange().getValues();
    
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === id) {
        sheet.deleteRow(i + 1); // +1 เพราะ array เริ่มที่ 0 แต่แถวชีตเริ่มที่ 1
        return { success: true, message: 'ลบข้อมูลสำเร็จ' };
      }
    }
    return { success: false, message: 'ไม่พบข้อมูลที่ต้องการลบ' };
  } catch (e) {
    return { success: false, message: e.message };
  } finally {
    lock.releaseLock();
  }
}

// แก้ไขข้อมูล (เฉพาะข้อมูลพื้นฐาน ไม่รวมสลิป)
function updateTransaction(formData) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = ss.getSheetByName('Transactions');
    const data = sheet.getDataRange().getValues();
    
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === formData.id) {
        // อัปเดตคอลัมน์ D(4)=Type, E(5)=Category, F(6)=Amount, G(7)=Note
        sheet.getRange(i + 1, 4).setValue(formData.type);
        sheet.getRange(i + 1, 5).setValue(formData.category);
        sheet.getRange(i + 1, 6).setValue(parseFloat(formData.amount));
        sheet.getRange(i + 1, 7).setValue(formData.note);
        return { success: true, message: 'อัปเดตข้อมูลสำเร็จ' };
      }
    }
    return { success: false, message: 'ไม่พบข้อมูลที่ต้องการแก้ไข' };
  } catch (e) {
    return { success: false, message: e.message };
  } finally {
    lock.releaseLock();
  }
}
