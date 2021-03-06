
import invariant                 from 'invariant'
import co                        from 'co'
import { resolve as resolveUrl } from 'url'
import screenfull                from 'screenfull'
import React                     from 'react'

// TODO: remove this dependency and use Options
import query                  from 'bemuse/utils/query'
import { getGrade }           from 'bemuse/rules/grade'

import SCENE_MANAGER          from 'bemuse/scene-manager'
import URLResource            from 'bemuse/resources/url'
import BemusePackageResources from 'bemuse/resources/bemuse-package'
import GameScene              from 'bemuse/game/game-scene'
import LoadingScene           from 'bemuse/game/ui/LoadingScene.jsx'
import ResultScene            from './ui/ResultScene'
import * as Analytics         from './analytics'
import { MISSED }             from 'bemuse/game/judgments'
import { unmuteAudio }        from 'bemuse/sampling-master'
import * as Options           from './entities/Options'
import createAutoVelocity     from './interactors/createAutoVelocity'

import { shouldDisableFullScreen, isTitleDisplayMode } from 'bemuse/devtools/query-flags'

if (module.hot) {
  module.hot.accept('bemuse/game/loaders/game-loader')
}

export function launch ({ server, song, chart, options, saveSpeed, saveLeadTime }) {
  // Unmute audio immediately so that it sounds on iOS.
  unmuteAudio()

  return co(function * () {
    // go fullscreen
    if (screenfull.enabled && !shouldDisableFullScreen()) {
      let safari = /Safari/.test(navigator.userAgent) &&
                  !/Chrom/.test(navigator.userAgent)
      if (!safari) screenfull.request()
    }

    // get the options from the store
    invariant(options, 'Options must be passed!')

    // initialize the loading specification
    let loadSpec  = { }
    if (song.resources) {
      loadSpec.assets = song.resources
      loadSpec.bms    = yield song.resources.file(chart.file)
    } else {
      let url         = server.url + '/' + song.path + '/' + encodeURIComponent(chart.file)
      let assetsUrl   = resolveUrl(url, 'assets/')
      loadSpec.bms    = new URLResource(url)
      loadSpec.assets = new BemusePackageResources(assetsUrl, {
        fallback: url,
        fallbackPattern: /\.(?:png|jpg)/,
      })
    }

    const latency = +query.latency || (+options['system.offset.audio-input'] / 1000) || 0
    const volume = getVolume(song)
    const scratch = Options.scratchPosition(options)
    const keyboardMapping = Options.keyboardMapping(options)

    // Speed handling
    const autoVelocity = createAutoVelocity({
      enabled: Options.isAutoVelocityEnabled(options),
      initialSpeed: +options['player.P1.speed'] || 1,
      desiredLeadTime: Options.leadTime(options),
      songBPM: chart.bpm.median
    })

    loadSpec.options = {
      audioInputLatency: latency,
      soundVolume: volume,
      tutorial: song.tutorial,
      players: [
        {
          speed: autoVelocity.getInitialSpeed(),
          autoplay: false,
          placement: options['player.P1.panel'],
          scratch: scratch,
          input: {
            keyboard: keyboardMapping,
          },
        },
      ],
    }

    // set video options
    if (Options.isBackgroundAnimationsEnabled(options)) {
      loadSpec.videoUrl = song.video_url
      loadSpec.videoOffset = +song.video_offset
    }

    // start loading the game
    const GameLoader = require('bemuse/game/loaders/game-loader')
    let loader = GameLoader.load(loadSpec)
    let { tasks, promise } = loader

    // display loading scene
    let loadingScene = React.createElement(LoadingScene, {
      tasks: tasks,
      song: chart.info,
      eyecatchImagePromise: loader.get('EyecatchImage')
    })
    yield SCENE_MANAGER.push(loadingScene)

    // if in title display mode, stop
    if (isTitleDisplayMode()) return

    // send data to analytics
    const gameMode = scratch ? 'BM' : 'KB'
    Analytics.gameStart(song, chart, gameMode, options)

    // wait for game to load and display the game
    let controller = yield promise
    yield SCENE_MANAGER.display(new GameScene(controller.display))
    controller.start()

    // listen to unload events
    function onUnload () {
      Analytics.gameQuit(song, chart, state)
    }
    window.addEventListener('beforeunload', onUnload, false)

    // wait for final game state
    let state = yield controller.promise

    // get player's state and save options
    let playerState = state.player(state.game.players[0])
    autoVelocity.handleGameFinish(playerState.speed, { saveSpeed, saveLeadTime })

    // send data to analytics & display evaluation
    window.removeEventListener('beforeunload', onUnload, false)
    if (state.finished) {
      Analytics.gameFinish(song, chart, state, gameMode)
      yield showResult(playerState, chart)
    } else {
      Analytics.gameEscape(song, chart, state)
    }
    controller.destroy()

    // go back to previous scene
    yield SCENE_MANAGER.pop()
  })
}

function showResult (playerState, chart) {
  return new Promise(resolve => {
    let stats     = playerState.stats
    let playMode  = playerState.player.options.scratch === 'off' ? 'KB' : 'BM'
    let props = {
      result: {
        '1':          stats.counts['1'],
        '2':          stats.counts['2'],
        '3':          stats.counts['3'],
        '4':          stats.counts['4'],
        'missed':     stats.counts[MISSED],
        'score':      stats.score,
        'maxCombo':   stats.maxCombo,
        'accuracy':   stats.accuracy,
        'totalCombo': stats.totalCombo,
        'log':        stats.log,
        'deltas':     stats.deltas,
        'grade':      getGrade(stats),
      },
      chart:    chart,
      playMode: playMode,
      onExit:   resolve,
    }
    SCENE_MANAGER.display(React.createElement(ResultScene, props)).done()
  })
}

// http://qiita.com/dtinth/items/1200681c517a3fb26357
const DEFAULT_REPLAYGAIN = -12.2 // dB

function getVolume (song) {
  const gain = replayGainFor(song)
  return Math.pow(10, ((gain == null ? DEFAULT_REPLAYGAIN : gain) + 8) / 20)
}

function replayGainFor (song) {
  if (typeof song.replaygain !== 'string') return null
  if (!/^\S+\s+dB$/.test(song.replaygain)) return null
  const gain = parseFloat(song.replaygain)
  if (isNaN(gain)) return null
  return gain
}
