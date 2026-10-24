import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { FocusService } from '../../src/main/services/focus-service.js'

test('专注累计分钟与今日分钟分别统计，连续天数遵循真实完成日期', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-stats-'))
  const dbPath = path.join(directory, 'focus.sqlite')
  const service = new FocusService({ dbPath })
  const db = new DatabaseSync(dbPath)
  try {
    assert.deepEqual(service.getStats(), { todayFocusMinutes: 0, totalFocusedMinutes: 0, totalCompletedSessions: 0, currentStreakDays: 0 })
    const insert = db.prepare('INSERT INTO focus_history (id, title, category_name, duration_minutes, completed_at) VALUES (?, ?, ?, ?, ?)')
    for (const [index, daysAgo] of [0, 1, 2, 5].entries()) {
      const completedAt = new Date()
      completedAt.setHours(12, 0, 0, 0)
      completedAt.setDate(completedAt.getDate() - daysAgo)
      insert.run(String(index), '写测试', '工作', 10, completedAt.getTime())
    }
    assert.deepEqual(service.getStats(), { todayFocusMinutes: 10, totalFocusedMinutes: 40, totalCompletedSessions: 4, currentStreakDays: 3 })
    db.prepare('DELETE FROM focus_history WHERE id = ?').run('0')
    assert.equal(service.getStats().currentStreakDays, 2)
    db.prepare('DELETE FROM focus_history WHERE id = ?').run('1')
    assert.equal(service.getStats().currentStreakDays, 0)
  } finally {
    db.close()
    service.stop()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
