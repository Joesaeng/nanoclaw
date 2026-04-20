#!/usr/bin/env python3
"""
NanoClaw 파이프라인 단계 자동 감지 스크립트
메시지 DB를 분석해서 현재 파이프라인 단계를 router_state에 저장.
cron 또는 수동으로 실행.

사용법:
  python3 pipeline.py              # 자동 감지
  python3 pipeline.py implementing # 수동 설정
"""

import sqlite3
import sys
import re

DB_PATH = '/home/splgames02/nanoclaw/store/messages.db'

STAGES = ['idle', 'design', 'review', 'approved', 'implementing']

KEYWORDS = {
    'implementing': ['구현 시작', '코드 작성', '구현할게', '구현 완료', '파일 생성'],
    'approved':     ['승인!', '승인했', '승인 완료', '구현 시작해도', '승인합니다'],
    'review':       ['리뷰', '검토해', '리뷰 요청', '설계문서 리뷰', '리뷰 결과'],
    'design':       ['설계문서', '설계 문서', '아키텍처', '설계할게', 'API 엔드포인트'],
    'idle':         [],
}

def detect_stage(db):
    rows = db.execute("""
        SELECT content, timestamp
        FROM messages
        WHERE chat_jid IN ('dc:1494232366900842526', 'dc2:1494232366900842526')
        ORDER BY timestamp DESC
        LIMIT 50
    """).fetchall()

    text = ' '.join(r[0] for r in rows).lower()

    for stage in ['implementing', 'approved', 'review', 'design']:
        for kw in KEYWORDS[stage]:
            if kw.lower() in text:
                return stage, kw

    return 'idle', None

def set_stage(db, stage):
    db.execute(
        "INSERT OR REPLACE INTO router_state (key, value) VALUES ('pipeline_stage', ?)",
        (stage,)
    )
    db.commit()

def get_stage(db):
    row = db.execute(
        "SELECT value FROM router_state WHERE key = 'pipeline_stage'"
    ).fetchone()
    return row[0] if row else None

def main():
    db = sqlite3.connect(DB_PATH)

    if len(sys.argv) > 1:
        stage = sys.argv[1]
        if stage not in STAGES:
            print(f'❌ 유효하지 않은 단계: {stage}')
            print(f'   가능한 값: {", ".join(STAGES)}')
            sys.exit(1)
        set_stage(db, stage)
        print(f'✅ 파이프라인 단계 설정: {stage}')
    else:
        stage, matched_kw = detect_stage(db)
        prev = get_stage(db)
        set_stage(db, stage)
        if prev != stage:
            print(f'🔄 파이프라인 단계 변경: {prev} → {stage} (키워드: {matched_kw})')
        else:
            print(f'✅ 파이프라인 단계 유지: {stage}')

    db.close()

if __name__ == '__main__':
    main()
