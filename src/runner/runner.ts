import path from 'node:path'
import stripAnsi from 'strip-ansi'
import * as vscode from 'vscode'
import { getTasks } from '@vitest/ws-client'
import type { ErrorWithDiff, File, ParsedStack, Task, TaskResult } from 'vitest'
import { basename, dirname, join, normalize } from 'pathe'
import { type TestData, TestFile, TestFolder, getTestData } from '../testTreeData'
import type { TestTree } from '../testTree'
import type { VitestFolderAPI } from '../api'
import { log } from '../log'
import { startDebugSession } from '../debug/startSession'
import type { TestDebugManager } from '../debug/debugManager'
import { showVitestError, waitUntilExists } from '../utils'
import { coverageContext } from '../coverage'
import { TestRunData } from './testRunData'

export class TestRunner extends vscode.Disposable {
  private continuousRequests = new Set<vscode.TestRunRequest>()
  private simpleTestRunRequest: vscode.TestRunRequest | null = null

  // TODO: doesn't support "projects" - run every project because Vitest doesn't support
  // granular filters yet (coming in Vitest 1.4.1)
  private testRunsByFile = new Map<string, vscode.TestRun>()

  constructor(
    private readonly controller: vscode.TestController,
    private readonly tree: TestTree,
    private readonly api: VitestFolderAPI,
    private readonly debug: TestDebugManager,
  ) {
    super(() => {
      api.clearListeners()
      this.testRunsByFile.clear()
      this.simpleTestRunRequest = null
      this.continuousRequests.clear()
      this.api.cancelRun()
    })

    api.onWatcherRerun((files, _trigger, collecting) => !collecting && this.startTestRun(files))

    api.onTaskUpdate((packs) => {
      packs.forEach(([testId, result]) => {
        const test = this.tree.getTestDataByTaskId(testId)
        if (!test) {
          log.error('Cannot find task during onTaskUpdate', testId)
          return
        }
        const testRun = this.getTestRunByData(test)
        // there is no test run for collected tests
        if (!testRun)
          return

        this.markResult(testRun, test.item, result)
      })
    })

    api.onCollected((files, collecting) => {
      if (!files)
        return
      files.forEach(file => this.tree.collectFile(this.api, file))
      if (collecting)
        return
      this.forEachTask(files, (task, data) => {
        const testRun = this.getTestRunByData(data)
        if (!testRun)
          return
        if (task.mode === 'skip' || task.mode === 'todo')
          testRun.skipped(data.item)
        else
          this.markResult(testRun, data.item, task.result, task)
      })
    })

    api.onFinished(async (files = []) => {
      try {
        await this.reportCoverage(files)
      }
      catch (err: any) {
        showVitestError(`Failed to report coverage. ${err.message}`, err)
      }

      files.forEach((file) => {
        const data = this.tree.getTestDataByTask(file) as TestFile | undefined
        const testRun = data && this.getTestRunByData(data)
        if (testRun && data) {
          this.markResult(testRun, data.item, file.result, file)
          this.endTestRun(testRun)
        }
      })
    })

    api.onConsoleLog(({ content, taskId }) => {
      const data = taskId ? tree.getTestDataByTaskId(taskId) : undefined
      const testRun = data && this.getTestRunByData(data)
      if (testRun) {
        testRun.appendOutput(
          content.replace(/(?<!\r)\n/g, '\r\n'),
          undefined,
          data?.item,
        )
      }
      else {
        log.info('[TEST]', content)
      }
    })
  }

  public async debugTests(request: vscode.TestRunRequest, token: vscode.CancellationToken) {
    await Promise.all([this.api.stopInspect(), this.debug.stop()])

    await startDebugSession(
      this.debug,
      this.api,
      this,
      request,
      token,
    )
  }

  private async watchContinuousTests(request: vscode.TestRunRequest, token: vscode.CancellationToken) {
    this.continuousRequests.add(request)

    token.onCancellationRequested(() => {
      this.continuousRequests.delete(request)
      if (!this.continuousRequests.size)
        this.api.unwatchTests()
    })

    if (!request.include?.length) {
      await this.api.watchTests()
    }
    else {
      const include = [...this.continuousRequests].map(r => r.include || []).flat()
      const files = getTestFiles(include)
      const testNamePatern = formatTestPattern(include)
      await this.api.watchTests(files, testNamePatern)
    }
  }

  public async runCoverage(request: vscode.TestRunRequest, token: vscode.CancellationToken) {
    try {
      await this.api.enableCoverage()
    }
    catch (err: any) {
      showVitestError(`Failed to enable coverage. ${err.message}`, err)
      return
    }

    token.onCancellationRequested(() => {
      // this.api.disableCoverage()
    })

    await this.runTests(request, token)
  }

  public async runTests(request: vscode.TestRunRequest, token: vscode.CancellationToken) {
    // if request is continuous, we just mark it and wait for the changes to files
    // users can also click on "run" button to trigger the run
    if (request.continuous)
      return await this.watchContinuousTests(request, token)

    this.simpleTestRunRequest = request

    token.onCancellationRequested(() => {
      this.simpleTestRunRequest = null
      this.api.cancelRun()
    })

    const tests = request.include || []

    if (!tests.length) {
      log.info(`Running all tests in ${basename(this.api.workspaceFolder.uri.fsPath)}`)
      await this.api.runFiles()
    }
    else {
      const testNamePatern = formatTestPattern(tests)
      const files = getTestFiles(tests)
      if (testNamePatern)
        log.info(`Running ${files.length} file(s) with name pattern: ${testNamePatern}`)
      else
        log.info(`Running ${files.length} file(s):`, files)
      await this.api.runFiles(files, testNamePatern)
    }

    this.simpleTestRunRequest = null
  }

  private getTestRunByData(data: TestData): vscode.TestRun | null {
    if (data instanceof TestFolder)
      return null
    if (data instanceof TestFile)
      return this.testRunsByFile.get(data.filepath) || null

    if ('file' in data)
      return this.getTestRunByData(data.file)
    return null
  }

  private isFileIncluded(file: string, include: readonly vscode.TestItem[] | vscode.TestItemCollection) {
    for (const _item of include) {
      const item = 'id' in _item ? _item : _item[1]
      const data = getTestData(item)
      if (data instanceof TestFile) {
        if (data.filepath === file)
          return true
      }
      else if (data instanceof TestFolder) {
        if (this.isFileIncluded(file, item.children))
          return true
      }
      else {
        if (data.file.filepath === file)
          return true
      }
    }
    return false
  }

  private getTestFilesInFolder(path: string) {
    function getFiles(folder: vscode.TestItem): string[] {
      const files: string[] = []
      for (const [_, item] of folder.children) {
        const data = getTestData(item)
        if (data instanceof TestFile)
          files.push(data.filepath)
        else if (data instanceof TestFolder)
          files.push(...getFiles(item))
      }
      return files
    }

    const folder = this.tree.getOrCreateFolderTestItem(this.api, path)
    return getFiles(folder)
  }

  private createContinuousRequest() {
    if (!this.continuousRequests.size)
      return null
    const include = []
    let primaryRequest: vscode.TestRunRequest | null = null
    for (const request of this.continuousRequests) {
      if (!request.include?.length)
        return request
      if (!primaryRequest)
        primaryRequest = request
      include.push(...request.include)
    }
    return new vscode.TestRunRequest(
      include,
      undefined,
      primaryRequest?.profile,
      true,
    )
  }

  private startTestRun(files: string[], primaryRequest?: vscode.TestRunRequest) {
    const request = primaryRequest || this.simpleTestRunRequest || this.createContinuousRequest()

    if (!request)
      return

    for (const file of files) {
      if (file[file.length - 1] === '/') {
        const files = this.getTestFilesInFolder(file)
        this.startTestRun(files, request)
        continue
      }

      // during test collection, we don't have test runs
      if (request.include && !this.isFileIncluded(file, request.include))
        continue

      const testRun = this.testRunsByFile.get(file)
      if (testRun)
        continue

      const base = basename(file)
      const dir = basename(dirname(file))
      const name = `${dir}${path.sep}${base}`
      const run = this.controller.createTestRun(request, name)

      TestRunData.register(run, file, request)
      const testItems = this.tree.getFileTestItems(file)
      function enqueue(test: vscode.TestItem) {
        run.enqueued(test)
        test.children.forEach(enqueue)
      }
      testItems.forEach(test => enqueue(test))

      this.testRunsByFile.set(file, run)
    }
  }

  public async reportCoverage(files: File[]) {
    if (!('FileCoverage' in vscode))
      return
    const config = await this.api.getCoverageConfig()
    if (!config.enabled)
      return

    // Vitest doesn't have hooks to wait until this is ready :(
    await waitUntilExists(join(config.reportsDirectory, 'coverage-final.json'), 5_000)

    const promises = files.map(async (file) => {
      const data = this.tree.getTestDataByTask(file) as TestFile | undefined
      const testRun = data && this.getTestRunByData(data)
      if (testRun)
        await coverageContext.apply(testRun, config.reportsDirectory)
    })

    await Promise.all(promises)
  }

  public async endTestRun(run: vscode.TestRun) {
    const data = TestRunData.get(run)
    this.testRunsByFile.delete(data.file)
    run.end()
  }

  private forEachTask(tasks: Task[], fn: (task: Task, test: TestData) => void) {
    getTasks(tasks).forEach((task) => {
      const test = this.tree.getTestDataByTask(task)
      if (!test) {
        log.error(`Test data not found for "${task.name}"`)
        return
      }
      fn(task, test)
    })
  }

  private markResult(testRun: vscode.TestRun, test: vscode.TestItem, result?: TaskResult, task?: Task) {
    if (!result) {
      testRun.started(test)
      return
    }
    switch (result.state) {
      case 'fail': {
        // error in a suite doesn't mean test fail
        if (task?.type === 'suite') {
          const errors = result.errors?.map(err =>
            new vscode.TestMessage(err.stack || err.message),
          )
          if (!errors)
            return
          test.error = errors.map(e => e.message.toString()).join('\n')
          testRun.errored(test, errors, result.duration)
          return
        }
        const errors = result.errors?.map(err =>
          testMessageForTestError(test, err),
        ) || []
        testRun.failed(test, errors, result.duration)
        break
      }
      case 'pass':
        testRun.passed(test, result.duration)
        break
      case 'todo':
      case 'skip':
        testRun.skipped(test)
        break
      case 'only':
      case 'run':
        testRun.started(test)
        break
      default: {
        const _never: never = result.state
        log.error('Unknown test result for', `${test.label}: ${result.state}`)
      }
    }
  }
}

function testMessageForTestError(testItem: vscode.TestItem, error: ErrorWithDiff | undefined): vscode.TestMessage {
  if (!error)
    return new vscode.TestMessage('Unknown error')

  let testMessage
  if (error.actual != null && error.expected != null && error.actual !== 'undefined' && error.expected !== 'undefined')
    testMessage = vscode.TestMessage.diff(stripAnsi(error.message) ?? '', error.expected, error.actual)
  else
    testMessage = new vscode.TestMessage(stripAnsi(error.message) ?? '')

  const location = parseLocationFromStacks(testItem, error.stacks ?? [])
  if (location) {
    const position = new vscode.Position(location.line - 1, location.column - 1)
    testMessage.location = new vscode.Location(vscode.Uri.file(location.path), position)
  }
  return testMessage
}

export interface DebuggerLocation {
  path: string
  line: number
  column: number
}

function getSourceFilepathAndLocationFromStack(stack: ParsedStack): { sourceFilepath?: string; line: number; column: number } {
  return {
    sourceFilepath: stack.file.replace(/\//g, path.sep),
    line: stack.line,
    column: stack.column,
  }
}

function parseLocationFromStacks(testItem: vscode.TestItem, stacks: ParsedStack[]): DebuggerLocation | undefined {
  if (stacks.length === 0)
    return undefined

  const targetFilepath = testItem.uri!.fsPath
  for (const stack of stacks) {
    const { sourceFilepath, line, column } = getSourceFilepathAndLocationFromStack(stack)
    if (sourceFilepath !== targetFilepath || Number.isNaN(column) || Number.isNaN(line))
      continue

    return {
      path: sourceFilepath,
      line,
      column,
    }
  }
}

function getTestFiles(tests: readonly vscode.TestItem[]) {
  return Array.from(
    new Set(tests.map((test) => {
      const data = getTestData(test)
      const fsPath = normalize(test.uri!.fsPath)
      if (data instanceof TestFolder)
        return `${fsPath}/`
      return fsPath
    }).filter(Boolean) as string[]),
  )
}

function formatTestPattern(tests: readonly vscode.TestItem[]) {
  const patterns: string[] = []
  for (const test of tests) {
    const data = getTestData(test)!
    if (!('getTestNamePattern' in data))
      continue
    patterns.push(data.getTestNamePattern())
  }
  if (!patterns.length)
    return undefined
  return patterns.join('|')
}
