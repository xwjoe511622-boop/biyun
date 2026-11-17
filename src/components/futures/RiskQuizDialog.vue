<script setup lang="ts">
import { useI18n } from 'vue-i18n'
/**
 * Futures risk-assessment quiz (Binance-style "pass the quiz to open futures"). Mounted once in App.vue and driven by
 * the futures-quiz store: intro (rules) → questions → result. Pass → the server opens the futures account and the caller
 * continues; fail → score, explanations and the retry rule (cooldown). Text follows the request language (zh/en).
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import DialogShell from '@/components/transfer/DialogShell.vue'
import { useFuturesQuizStore } from '@/stores/futures-quiz'
import { describeApiError } from '@/modules/api/error-codes'
import { requestLanguage } from '@/modules/api/http'
import {
  allAnswered, choose, cooldownOf, fetchQuizStatus, pick, quizZh, startQuiz, submitQuiz, waitText,
  type QuizAnswers, type QuizQuestion, type QuizResult, type QuizStatus,
} from '@/modules/futures/quiz'

const store = useFuturesQuizStore()
type Step = 'loading' | 'intro' | 'questions' | 'result' | 'error'
const step = ref<Step>('loading')
const status = ref<QuizStatus | null>(null)
const questions = ref<QuizQuestion[]>([])
const attemptId = ref('')
const answers = ref<QuizAnswers>({})
const result = ref<QuizResult | null>(null)
const error = ref('')
const busy = ref(false)
const cooldownUntil = ref<number | null>(null)
const now = ref(Date.now())
const zh = computed(() => quizZh())
const { t: uiText } = useI18n({ useScope: 'global' })
let timer: ReturnType<typeof setInterval> | null = null

const answered = computed(() => questions.value.filter((q) => (answers.value[String(q.id)] ?? []).length > 0).length)
const canSubmit = computed(() => allAnswered(questions.value, answers.value) && !busy.value)
const waiting = computed(() => cooldownUntil.value !== null && cooldownUntil.value > now.value)
const wrong = computed(() => {
  const r = result.value
  if (r === null) return []
  return r.results.filter((x) => !x.correct).map((x) => ({ ...x, q: questions.value.find((q) => q.id === x.id) }))
})

async function load(): Promise<void> {
  step.value = 'loading'
  error.value = ''
  result.value = null
  try {
    const s = await fetchQuizStatus()
    status.value = s
    if (!s.required) {
      store.finish(true)
      return
    }
    cooldownUntil.value = s.cooldownUntil
    step.value = 'intro'
  } catch (e) {
    error.value = describeApiError(e, requestLanguage())
    step.value = 'error'
  }
}

async function begin(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    const s = await startQuiz()
    if (!s.required) {
      store.finish(true)
      return
    }
    questions.value = s.questions ?? []
    attemptId.value = s.attemptId ?? ''
    answers.value = {}
    result.value = null
    step.value = 'questions'
  } catch (e) {
    const at = cooldownOf(e)
    if (at !== null) {
      cooldownUntil.value = at
      step.value = 'intro'
    } else {
      error.value = describeApiError(e, requestLanguage())
    }
  } finally {
    busy.value = false
  }
}

function toggle(q: QuizQuestion, key: string): void {
  answers.value = { ...answers.value, [String(q.id)]: choose(q, answers.value[String(q.id)], key) }
}

function chosen(q: QuizQuestion, key: string): boolean {
  return (answers.value[String(q.id)] ?? []).includes(key)
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return
  busy.value = true
  error.value = ''
  try {
    const r = await submitQuiz(attemptId.value, answers.value)
    result.value = r
    cooldownUntil.value = r.passed ? null : r.cooldownUntil
    step.value = 'result'
  } catch (e) {
    error.value = describeApiError(e, requestLanguage())
  } finally {
    busy.value = false
  }
}

function close(): void {
  store.finish(result.value?.passed === true)
}

watch(() => store.visible, (open) => {
  if (open) {
    void load()
    timer = setInterval(() => { now.value = Date.now() }, 1000)
  } else if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
}, { immediate: true })
onBeforeUnmount(() => { if (timer !== null) clearInterval(timer) })
</script>

<template>
  <DialogShell :open="store.visible" :title="uiText('riskQuizDialog.futuresRiskAssessment')" width="620px" :close-label="uiText('riskQuizDialog.close')" @close="close">
    <div class="quiz" data-testid="risk-quiz">
      <p v-if="step === 'loading'" class="muted">{{ uiText('riskQuizDialog.loading') }}</p>

      <template v-else-if="step === 'error'">
        <p class="notice notice-error wrap-anywhere">{{ error }}</p>
        <div class="actions"><button class="btn" type="button" @click="load">{{ uiText('riskQuizDialog.retry') }}</button></div>
      </template>

      <template v-else-if="step === 'intro'">
        <p>{{ uiText('riskQuizDialog.futuresUseLeverageASmallPriceMoveCanWipe') }}</p>
        <ul class="rules">
          <li>{{ uiText('riskQuizDialog.questionsSingleOrMultipleChoice', { questionsPerAttempt: status?.questionsPerAttempt ?? 10 }) }}</li>
          <li>{{ uiText('riskQuizDialog.passWithCorrectYourFuturesAccountIsOpenedRight', { passScore: status?.passScore ?? 100 }) }}</li>
          <li v-if="(status?.cooldownMinutes ?? 0) > 0">{{ uiText('riskQuizDialog.ifYouDoNotPassYouCanRetryAfter', { cooldownMinutes: status?.cooldownMinutes }) }}</li>
        </ul>
        <p v-if="waiting" class="notice" data-testid="quiz-cooldown">{{ uiText('riskQuizDialog.youDidNotPassLastTimeRetryIn') }}<span class="num">{{ waitText(cooldownUntil ?? 0, now, zh) }}</span>{{ uiText('riskQuizDialog.label') }}</p>
        <p v-if="error" class="notice notice-error wrap-anywhere">{{ error }}</p>
        <div class="actions">
          <button class="btn" type="button" @click="close">{{ uiText('riskQuizDialog.later') }}</button>
          <button class="btn btn-primary" type="button" :disabled="busy || waiting" data-testid="quiz-start" @click="begin">{{ uiText('riskQuizDialog.start') }}</button>
        </div>
      </template>

      <template v-else-if="step === 'questions'">
        <ol class="questions">
          <li v-for="q in questions" :key="q.id" class="question" :data-testid="`quiz-q-${q.id}`">
            <p class="qtext">{{ pick(q.textZh, q.textEn, zh) }} <span class="tag">{{ q.type === 'multi' ? uiText('riskQuizDialog.multiple') : uiText('riskQuizDialog.single') }}</span></p>
            <label v-for="o in q.options" :key="o.key" class="option" :class="{ on: chosen(q, o.key) }">
              <input :type="q.type === 'multi' ? 'checkbox' : 'radio'" :name="`q${q.id}`" :checked="chosen(q, o.key)" @change="toggle(q, o.key)" />
              <span class="key">{{ o.key }}.</span> {{ pick(o.zh, o.en, zh) }}
            </label>
          </li>
        </ol>
        <p v-if="error" class="notice notice-error wrap-anywhere">{{ error }}</p>
        <div class="actions sticky">
          <span class="muted num">{{ uiText('riskQuizDialog.answered', { answered, length: questions.length }) }}</span>
          <button class="btn btn-primary" type="button" :disabled="!canSubmit" data-testid="quiz-submit" @click="submit">{{ uiText('riskQuizDialog.submit') }}</button>
        </div>
      </template>

      <template v-else-if="step === 'result' && result">
        <template v-if="result.passed">
          <p class="pass" data-testid="quiz-passed">{{ uiText('riskQuizDialog.passed') }} · <span class="num">{{ result.score }}/{{ result.total }}</span></p>
          <p>{{ result.opened === false ? uiText('riskQuizDialog.yourFuturesAccountIsBeingOpened') : uiText('riskQuizDialog.yourFuturesAccountIsOpenYouCanStartTrading') }}</p>
          <div class="actions"><button class="btn btn-primary" type="button" data-testid="quiz-done" @click="close">{{ uiText('riskQuizDialog.startTrading') }}</button></div>
        </template>
        <template v-else>
          <p class="fail" data-testid="quiz-failed">{{ uiText('riskQuizDialog.notPassed') }} · <span class="num">{{ result.score }}/{{ result.total }}</span>
            <span class="muted">{{ uiText('riskQuizDialog.needed', { passScore: result.passScore }) }}</span></p>
          <ol class="explain">
            <li v-for="w in wrong" :key="w.id">
              <p class="qtext">{{ w.q ? pick(w.q.textZh, w.q.textEn, zh) : `#${w.id}` }}</p>
              <p class="muted">{{ pick(w.explainZh, w.explainEn, zh) }}</p>
            </li>
          </ol>
          <p class="notice">{{ waiting ? uiText('riskQuizDialog.youCanRetryIn') : '' }}<span v-if="waiting" class="num">{{ waitText(cooldownUntil ?? 0, now, zh) }}</span>{{ waiting ? uiText('riskQuizDialog.label') : uiText('riskQuizDialog.youCanRetryNow') }}</p>
          <div class="actions">
            <button class="btn" type="button" @click="close">{{ uiText('riskQuizDialog.close') }}</button>
            <button class="btn btn-primary" type="button" :disabled="busy || waiting" data-testid="quiz-retry" @click="begin">{{ uiText('riskQuizDialog.retry2') }}</button>
          </div>
        </template>
      </template>
    </div>
  </DialogShell>
</template>

<style scoped>
.quiz { display: flex; flex-direction: column; gap: 12px; max-height: min(70vh, 720px); overflow-y: auto; }
.rules { margin: 0; padding-left: 20px; display: grid; gap: 4px; }
.questions, .explain { margin: 0; padding-left: 20px; display: grid; gap: 14px; }
.question { display: grid; gap: 6px; }
.qtext { margin: 0; font-weight: 600; }
.tag { font-size: 12px; font-weight: 400; padding: 1px 6px; border-radius: 4px; border: 1px solid var(--line, #ddd); margin-left: 6px; }
.option { display: flex; gap: 8px; align-items: flex-start; padding: 8px 10px; border: 1px solid var(--line, #ddd); border-radius: 6px; cursor: pointer; }
.option.on { border-color: var(--accent, #f0b90b); }
.option input { margin-top: 3px; }
.key { font-weight: 600; }
.actions { display: flex; justify-content: flex-end; align-items: center; gap: 10px; }
.actions.sticky { position: sticky; bottom: 0; background: var(--panel, inherit); padding-top: 8px; justify-content: space-between; }
.pass { color: var(--up, #0ecb81); font-size: 18px; font-weight: 700; margin: 0; }
.fail { color: var(--down, #f6465d); font-size: 18px; font-weight: 700; margin: 0; }
@media (max-width: 640px) { .option { padding: 10px; } }
</style>
