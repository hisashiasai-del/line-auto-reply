// リマインド文面
const { formatJst } = require('./time');

const SENDER_NAME = process.env.REMINDER_SENDER_NAME || 'LIS Sales Japan';

function honorific(contact) {
  if (contact.kind === 'company') {
    if (contact.company_name && contact.name) return contact.company_name + ' ' + contact.name + '様';
    if (contact.company_name) return contact.company_name + 'ご担当者様';
  }
  return contact.name ? contact.name + '様' : 'ご担当者様';
}

function buildReminderText(reminder, meeting, contact) {
  const when = formatJst(meeting.start_at);
  const title = meeting.title || meeting.meeting_type || '面談';
  const dayWord = reminder.kind === 'same_day' ? '本日' : '明日';
  // 前日リマインドが当日になってから送られる場合（送り逃しの即時送信）は日付表現を合わせる
  const sendDay = formatJst(Date.now()).date;
  const dayLabel = reminder.kind === 'day_before' && sendDay === when.date ? '本日' : dayWord;

  const lines = [
    honorific(contact),
    '',
    'いつもお世話になっております。' + SENDER_NAME + 'でございます。',
    dayLabel + ' ' + when.date + ' ' + when.time + 'より、「' + title + '」を予定しております。',
  ];
  if (meeting.location) lines.push('場所／URL：' + meeting.location);
  lines.push('');
  if (reminder.kind === 'same_day') {
    lines.push('本日はどうぞよろしくお願いいたします。');
    lines.push('ご都合が悪くなった場合やお時間に遅れそうな場合は、このメッセージにご返信ください。');
  } else {
    lines.push('ご都合が悪くなった場合は、お手数ですがこのメッセージにご返信ください。');
    lines.push('当日はどうぞよろしくお願いいたします。');
  }
  return lines.join('\n');
}

module.exports = { buildReminderText };
