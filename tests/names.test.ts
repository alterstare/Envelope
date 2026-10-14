import { describe, expect, it } from 'vitest'
import { decodeMojibake, fillGaps, isLostChar, mojibakeLevel, repairSiblings } from '../src/core/names/mojibake'
import { stem, trackKey, trackNumber } from '../src/core/names/normalize'
import { folderRole, labelOf, seOf } from '../src/core/library/roles'
import { toMojibake } from './helpers'

describe('뷁어', () => {
  const names = ['トラック1_導入編.mp3', 'おまけ', 'SE無し', 'イラスト.jpg']

  it('repairs names read as CP949', () => {
    for (const n of names) {
      const broken = toMojibake(n)
      expect(broken).not.toBe(n)
      expect(mojibakeLevel(broken)).toBe('strong')
      expect(decodeMojibake(broken)).toBe(n)
    }
  })

  it('leaves Korean, Japanese and ASCII names alone', () => {
    for (const n of ['한국어 자막판 트랙1.mp3', '【한국어 자막판】 검도소녀', 'トラック１.wav', 'Track01.mp3', 'SE없음']) expect(mojibakeLevel(n)).toBe('none')
  })

  it('takes short names only next to strong ones', () => {
    const short = toMojibake('編') // one character
    expect(mojibakeLevel(short)).toBe('weak')
    expect(repairSiblings([short, '한국어'])[0].mojibake).toBe(false)
    expect(repairSiblings([short, toMojibake('おまけ')]).map((r) => r.text)).toEqual(['編', 'おまけ'])
    expect(repairSiblings([short], true)[0].text).toBe('編')
  })

  it('fills lost characters from reference names', () => {
    // 畜 (0x927B) and 望 (0x965D) have trail bytes CP949 can't hold.
    expect(isLostChar('畜')).toBe(true)
    expect(isLostChar('望')).toBe(true)
    expect(isLostChar('導')).toBe(false)
    expect(fillGaps('【声】旅行_定_の話', ['【声】旅行予定表の話 完全版'])).toEqual({ text: '【声】旅行予定表の話', filled: 2 })
  })

  it('keeps real separators and unknown gaps', () => {
    // "_" between words in the name, nothing between them in the title
    expect(fillGaps('声_汚れ_人生', ['声汚れ人生']).text).toBe('声_汚れ_人生')
    expect(fillGaps('プロロ_グ', ['関係ない題名']).text).toBe('プロロ_グ')
  })
})

describe('normalize', () => {
  it('strips double extensions', () => {
    expect(stem('a.mp3.vtt')).toBe('a')
    expect(stem('a.ja.srt')).toBe('a.ja')
    expect(stem('1.Track1.wav')).toBe('1.Track1')
  })

  it('gives versions of one track the same key', () => {
    const same = (a: string, b: string): void => expect(trackKey(a)).toBe(trackKey(b))
    same('トラック1_SE有り', 'トラック1_SE無し')
    same('0.「序章」_NoSE', '0.「序章」')
    same('01_足コキ', '01足コキ')
    same('1.話　【春】', '1.話【春】')
    same('트랙1_SE없음', '트랙1_SE있음')
    same('01. 최면 시작(SE 제거)', '01. 최면 시작')
    same('トラック１SEなし', 'トラック１')
    expect(trackKey('トラック1')).not.toBe(trackKey('トラック2'))
  })

  it('finds track numbers', () => {
    expect(trackNumber('トラック１')).toBe(1)
    expect(trackNumber('ABC_Tr3_v1_20240130')).toBe(3)
    expect(trackNumber('プロローグ')).toBeNull()
  })
})

describe('folder roles', () => {
  it('reads SE markers', () => {
    for (const n of ['SEなし', 'SE無し', 'SE無', 'se_no', 'Voice_Only', 'wav_NoSE', 'SE제거', 'SE 없음', 'SE(효과음) 없음', '【音声ファイル・SEなし】作品'])
      expect(seOf(n), n).toBe('off')
    for (const n of ['SEあり', 'SE有り', 'SE有', 'se', 'voice_se', 'SE포함', 'SE 있음', '【音声ファイル・SEあり】作品']) expect(seOf(n), n).toBe('on')
    expect(seOf('SEX')).toBeNull()
    expect(seOf('mp3')).toBeNull()
  })

  it('reads formats, extras and samples', () => {
    expect(folderRole('01_wav').format).toBe('wav')
    expect(folderRole('音声ファイル（WAV）').format).toBe('wav')
    expect(folderRole('wav_NoSE')).toMatchObject({ format: 'wav', se: 'off' })
    expect(folderRole('おまけ').extra).toBe(true)
    expect(folderRole('2.特典').extra).toBe(true)
    expect(folderRole('덤').extra).toBe(true)
    expect(folderRole('SAMPLE').sample).toBe(true)
  })

  it('finds edition names, not wrapper folders', () => {
    for (const n of ['本編', '本篇', '本登録', 'Master', 'DLsite', '★본편', 'RJ01234567', 'mp3', 'SE有', 'se', '01_SE포함_mp3', '【音声ファイル・WAV】'])
      expect(labelOf(n), n).toBe('')
    expect(labelOf('ノーマルversion')).not.toBe('')
    expect(labelOf('BSS視点')).toBe('BSS視点')
  })
})
