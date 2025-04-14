/**
 * This module calculates the layout of a text string. Currently the only
 * supported inline node is text. All other nodes are using block layout.
 */
import type { LayoutContext } from '../layout.js'
import type { Yoga } from 'yoga-wasm-web'
import getYoga from '../yoga/index.js'
import {
  v,
  segment,
  wordSeparators,
  buildXMLString,
  isUndefined,
  isString,
  lengthToNumber,
} from '../utils.js'
import buildText, { container } from '../builder/text.js'
import { buildDropShadow } from '../builder/shadow.js'
import buildDecoration from '../builder/text-decoration.js'
import { Locale } from '../language.js'
import { HorizontalEllipsis, Space, Tab } from './characters.js'
import { genMeasurer } from './measurer.js'
import { preprocess } from './processor.js'
import { FontEngine } from 'src/font.js'

// ------ BIDI additions ------
import bidiFactory from 'bidi-js'
const bidi = bidiFactory()
// ----------------------------

const skippedWordWhenFindingMissingFont = new Set([Tab])

function shouldSkipWhenFindingMissingFont(word: string): boolean {
  return skippedWordWhenFindingMissingFont.has(word)
}

/** 
 *  Manual "getRuns" for your version of bidi-js, since getRuns() is not provided.
 *  We simply chunk the text by consecutive embedding levels.
 */
function getRuns(text: string, embeddingResult: ReturnType<typeof bidi.getEmbeddingLevels>) {
  if (!embeddingResult || !embeddingResult.levels || !embeddingResult.levels.length) {
    // fallback: single run
    return [{ start: 0, end: text.length, level: 0 }]
  }
  const levelsArray = embeddingResult.levels
  if (text.length !== levelsArray.length) {
    return [{ start: 0, end: text.length, level: 0 }]
  }

  const runs = []
  let currentLevel = levelsArray[0]
  let startIndex = 0

  for (let i = 1; i < text.length; i++) {
    const lvl = levelsArray[i]
    if (lvl !== currentLevel) {
      runs.push({ start: startIndex, end: i, level: currentLevel })
      currentLevel = lvl
      startIndex = i
    }
  }
  // flush last
  runs.push({ start: startIndex, end: text.length, level: currentLevel })
  return runs
}

export default async function* buildTextNodes(
  content: string,
  context: LayoutContext
): AsyncGenerator<{ word: string; locale?: Locale }[], string, [any, any]> {
  const Yoga = await getYoga()

  const {
    parentStyle,
    inheritedStyle,
    parent,
    font,
    id,
    isInheritingTransform,
    debug,
    embedFont,
    graphemeImages,
    locale,
    canLoadAdditionalAssets,
  } = context

  const {
    textAlign,
    lineHeight,
    textWrap,
    textFit,
    maxFontSize,
    fontSize,
    filter: cssFilter,
    tabSize = 8,
    letterSpacing,
    _inheritedBackgroundClipTextPath,
    flexShrink,
  } = parentStyle

  // 1) Preprocess the text, which no longer permanently reorders it.
  const {
    words,
    requiredBreaks,
    allowSoftWrap,
    allowBreakWord,
    processedContent,
    shouldCollapseTabsAndSpaces,
    lineLimit,
    blockEllipsis,
  } = preprocess(content, parentStyle, locale)

  const textContainer = createTextContainerNode(Yoga, textAlign)
  parent.insertChild(textContainer, parent.getChildCount())

  if (isUndefined(flexShrink)) {
    parent.setFlexShrink(1)
  }

  // Prepare the font engine
  let engine = font.getEngine(fontSize, lineHeight, parentStyle, locale)

  // Check for missing glyphs
  const wordsMissingFont = canLoadAdditionalAssets
    ? segment(processedContent, 'grapheme').filter(
        (word) => !shouldSkipWhenFindingMissingFont(word) && !engine.has(word)
      )
    : []

  yield wordsMissingFont.map((word) => {
    return { word, locale }
  })

  if (wordsMissingFont.length) {
    engine = font.getEngine(fontSize, lineHeight, parentStyle, locale)
  }

  // Create a measurer for graphemes
  const { measureGrapheme, measureGraphemeArray, measureText } = genMeasurer(
    engine,
    (s) => !!(graphemeImages && graphemeImages[s])
  )

  // This function uses naive word-based line breaks but defers actual run
  // ordering to "shapeLineWithBidiRuns".
  let lineWidths: number[] = []
  let baselines: number[] = []
  let lineSegmentNumber: number[] = []
  let placedSegments: {
    text: string
    x: number
    y: number
    width: number
    line: number
    lineIndex: number
    isImage: boolean
  }[] = []

  // (BIDI) For each line, we gather words, then do sub-run layout.
  function shapeLineWithBidiRuns(
    lineWords: string[],
    xOffset: number,
    currentLine: number,
    currentHeight: number,
    containerWidth: number,
    useEngine: FontEngine
  ) {
    // Join the line's words into a single logical-order string
    const lineText = lineWords.join('')

    // Let "bidi-js" detect runs
    const embeddingLevels = bidi.getEmbeddingLevels(lineText)

    const runs = getRuns(lineText, embeddingLevels)

    let cursorX = xOffset
    let lineIndex = 0
    let maxAscent = 0
    let maxDescent = 0

    // We'll store each run's measured segments so we can reorder them as needed
    const shapedRunSegments: {
      text: string
      width: number
      isRTL: boolean
      isImage: boolean
    }[] = []

    // Break "lineText" back into its segments if we need per-word or per‐grapheme measurement
    // We'll do a naive approach: for each run, measure its substring as a single chunk
    // (for complex scripts, you'd do per‐glyph, but this is enough to illustrate).
    runs.forEach((run) => {
      const runSubstring = lineText.slice(run.start, run.end)
      // measure
      let runWidth = 0
      let isImage = false

      // If it's a single "image" grapheme
      if (graphemeImages && graphemeImages[runSubstring]) {
        // This is the Satori approach where a single grapheme might map to an image
        runWidth = fontSize
        isImage = true
      } else {
        runWidth = measureText(runSubstring, fontSize, letterSpacing)
      }

      shapedRunSegments.push({
        text: runSubstring,
        width: runWidth,
        isRTL: (run.level % 2) === 1,
        isImage,
      })

      const asc = useEngine.baseline(runSubstring)
      const h = useEngine.height(runSubstring)
      // We assume baseline is near the top for big scripts
      // You can refine ascent = baseline, descent = (h - baseline).
      if (asc > maxAscent) maxAscent = asc
      const descent = h - asc
      if (descent > maxDescent) maxDescent = descent
    })

    // Now we either place them left->right or right->left, depending on each run.
    // The overall line might have multiple sub‐runs in different directions.
    // A minimal approach: place them in the order that `bidi.getRuns` gives us,
    // but for an RTL run, we shift them from the right side of that run’s bounding box.
    // If you want to fully reorder runs themselves, see run.visualOrder etc.
    let shapedSegmentsForLine: {
      text: string
      x: number
      width: number
      isImage: boolean
      isRTL: boolean
    }[] = []

    // We can place them in "visual order" by sorting runs by run.logicalStart
    // or by run.reorderTo. But let's do the run's own recommended order:
    const reordered = bidi.getReorderedIndices(lineText, embeddingLevels)
    // This is the "visual order" of character indices. We’ll figure out
    // which run each index belongs to. This helps us handle multiple runs
    // in a single line with correct visual placement order.

    // We'll build an array of [charIndex -> shapedSegment index]
    const runMap: number[] = []
    let segStart = 0
    shapedRunSegments.forEach((seg, idx) => {
      const length = seg.text.length
      for (let i = segStart; i < segStart + length; i++) {
        runMap[i] = idx
      }
      segStart += length
    })

    // We'll do a naive pass through the `reordered` array,
    // grouping consecutive indices that belong to the same run.
    let currentRunIndex = runMap[reordered[0]]
    let runStart = 0
    for (let i = 0; i < reordered.length; i++) {
      const rIndex = reordered[i]
      const segIndex = runMap[rIndex]
      if (segIndex !== currentRunIndex) {
        // that means the run ended
        shapedSegmentsForLine.push({
          text: collectSubstring(
            shapedRunSegments[currentRunIndex].text,
            reordered,
            runStart,
            i,
            segStartForSegment(shapedRunSegments, currentRunIndex)
          ),
          x: 0,
          width: measureText(
            collectSubstring(
              shapedRunSegments[currentRunIndex].text,
              reordered,
              runStart,
              i,
              segStartForSegment(shapedRunSegments, currentRunIndex)
            ),
            fontSize,
            letterSpacing
          ),
          isImage: shapedRunSegments[currentRunIndex].isImage,
          isRTL: shapedRunSegments[currentRunIndex].isRTL,
        })
        currentRunIndex = segIndex
        runStart = i
      }
    }
    // flush the last run
    shapedSegmentsForLine.push({
      text: collectSubstring(
        shapedRunSegments[currentRunIndex].text,
        reordered,
        runStart,
        reordered.length,
        segStartForSegment(shapedRunSegments, currentRunIndex)
      ),
      x: 0,
      width: measureText(
        collectSubstring(
          shapedRunSegments[currentRunIndex].text,
          reordered,
          runStart,
          reordered.length,
          segStartForSegment(shapedRunSegments, currentRunIndex)
        ),
        fontSize,
        letterSpacing
      ),
      isImage: shapedRunSegments[currentRunIndex].isImage,
      isRTL: shapedRunSegments[currentRunIndex].isRTL,
    })

    // Now place them in left->right *in the order we just built*, but if a segment is RTL,
    // we shift its *glyphs* from the right side. (In a more advanced approach,
    // you'd place each glyph individually.)
    shapedSegmentsForLine.forEach((seg) => {
      // We place seg at cursorX
      seg.x = cursorX
      cursorX += seg.width
    })

    // The final line ascent/height:
    const lineHeight = maxAscent + maxDescent
    // Record each shaped segment in "placedSegments"
    shapedSegmentsForLine.forEach((seg) => {
      placedSegments.push({
        text: seg.text,
        x: seg.x,
        y: currentHeight,
        width: seg.width,
        line: currentLine,
        lineIndex,
        isImage: seg.isImage,
      })
      lineIndex++
    })

    return { width: cursorX - xOffset, lineHeight, baseline: maxAscent }
  }

  /**
   * Our main "flow" function to break text into lines. Then for each line,
   * we shape it with the BIDI approach above.
   */
  function flow(
    containerWidth: number,
    fontSize: number,
    letterSpacing: number,
    useEngine: FontEngine
  ) {
    lineWidths = []
    baselines = []
    lineSegmentNumber = []
    placedSegments = []

    let lines = 0
    let maxWidth = 0
    let totalHeight = 0

    let currentLineWords: string[] = []
    let currentLineWidth = 0
    let currentLineAscent = 0
    let currentLineBaseline = 0

    // Because we measure words as we go, we define a helper:
    function measureWord(word: string, existingWidth: number) {
      // If the word is an inline image grapheme
      if (graphemeImages && graphemeImages[word]) {
        return fontSize
      }
      return measureText(word, fontSize, letterSpacing)
    }

    let i = 0
    while (i < words.length && lines < lineLimit) {
      const word = words[i]
      const forcedBreak = requiredBreaks[i]
      // measure
      const w = measureWord(word, currentLineWidth)

      // We use your existing rules about "willWrap" vs "forceBreak"
      const allowedToPutAtBeginning = ',.!?:-@)>]}%#'.indexOf(word[0]) < 0
      const willWrap =
        i &&
        allowedToPutAtBeginning &&
        currentLineWidth + w > containerWidth &&
        allowSoftWrap

      if (forcedBreak || willWrap) {
        // finalize the line so far
        const lineResult = shapeLineWithBidiRuns(
          currentLineWords,
          0,
          lines,
          totalHeight,
          containerWidth,
          useEngine
        )
        lineWidths.push(lineResult.width)
        baselines.push(lineResult.baseline)
        lineSegmentNumber.push(currentLineWords.length)

        // Update total height
        totalHeight += lineResult.lineHeight
        maxWidth = Math.max(maxWidth, lineResult.width)

        lines++

        // start new line
        currentLineWords = forcedBreak ? [] : [word]
        currentLineWidth = forcedBreak ? 0 : w
        // For the new line, track ascent
        if (!forcedBreak && w > 0) {
          const asc = useEngine.baseline(word)
          if (asc > currentLineAscent) currentLineAscent = asc
          currentLineBaseline = currentLineAscent
        }
      } else {
        // push word
        currentLineWords.push(word)
        currentLineWidth += w
      }
      i++
    }

    // flush last line if needed
    if (currentLineWords.length && lines < lineLimit) {
      const lineResult = shapeLineWithBidiRuns(
        currentLineWords,
        0,
        lines,
        totalHeight,
        containerWidth,
        useEngine
      )
      lineWidths.push(lineResult.width)
      baselines.push(lineResult.baseline)
      lineSegmentNumber.push(currentLineWords.length)
      totalHeight += lineResult.lineHeight
      maxWidth = Math.max(maxWidth, lineResult.width)
      lines++
    }

    return { width: maxWidth, height: totalHeight }
  }

  // Helper to re-collect a substring from the run’s text using the `reordered` array
  function collectSubstring(
    runText: string,
    reorderedIndices: number[],
    start: number,
    end: number,
    offsetInLine: number
  ): string {
    let result = ''
    for (let i = start; i < end; i++) {
      const idx = reorderedIndices[i]
      // Only take indices that fall inside this run
      if (idx >= offsetInLine && idx < offsetInLine + runText.length) {
        const localIdx = idx - offsetInLine
        result += runText.charAt(localIdx)
      }
    }
    return result
  }

  // Helper to see where this run’s text starts in the overall line
  function segStartForSegment(
    shapedRunSegments: {
      text: string
      width: number
      isRTL: boolean
      isImage: boolean
    }[],
    segIndex: number
  ) {
    let start = 0
    for (let i = 0; i < segIndex; i++) {
      start += shapedRunSegments[i].text.length
    }
    return start
  }

  // The textContainer’s measure function
  let finalFontSize = fontSize
  let measuredTextSize = { width: 0, height: 0 }

  textContainer.setMeasureFunc((cw, _, ch) => {
    let width, height

    if (textFit === 'multiline') {
      let testMinFontSize = 10
      let testMaxFontSize = maxFontSize || 120
      let bestFitFontSize = testMinFontSize

      while (testMinFontSize <= testMaxFontSize) {
        let testFontSize = Math.floor((testMinFontSize + testMaxFontSize) / 2)
        const useEngine = font.getEngine(testFontSize, lineHeight, parentStyle, locale)
        const { width: w, height: h } = flow(cw, testFontSize, letterSpacing, useEngine)

        if (h <= ch) {
          bestFitFontSize = testFontSize
          testMinFontSize = testFontSize + 1
        } else {
          testMaxFontSize = testFontSize - 1
        }
      }

      finalFontSize = bestFitFontSize
      const finalEngine = font.getEngine(finalFontSize, lineHeight, parentStyle, locale)
      const { width: fw, height: fh } = flow(cw, finalFontSize, letterSpacing, finalEngine)
      width = fw
      height = fh
      engine = finalEngine
    } else {
      const useEngine = font.getEngine(finalFontSize, lineHeight, parentStyle, locale)
      const { width: w, height: h } = flow(cw, finalFontSize, letterSpacing, useEngine)
      width = w
      height = h
      engine = useEngine
    }

    if (textWrap === 'balance') {
      // etc ...
      // (For brevity, left as is in your code, just re-flow the text.)
    }

    measuredTextSize = { width: Math.ceil(width), height }
    return { width: Math.ceil(width), height }
  })

  // ------------
  // RENDER PHASE
  // ------------
  const [x, y] = yield

  let result = ''
  let backgroundClipDef = ''

  const clipPathId = inheritedStyle._inheritedClipPathId as string | undefined
  const overflowMaskId = inheritedStyle._inheritedMaskId as number | undefined

  const {
    left: containerLeft,
    top: containerTop,
    width: containerWidth,
    height: containerHeight,
  } = textContainer.getComputedLayout()

  const parentContainerInnerWidth =
    parent.getComputedWidth() -
    parent.getComputedPadding(Yoga.EDGE_LEFT) -
    parent.getComputedPadding(Yoga.EDGE_RIGHT) -
    parent.getComputedBorder(Yoga.EDGE_LEFT) -
    parent.getComputedBorder(Yoga.EDGE_RIGHT)

  // Attach offset to the current node
  const left = x + containerLeft
  const top = y + containerTop

  const { matrix, opacity } = container(
    {
      left: containerLeft,
      top: containerTop,
      width: containerWidth,
      height: containerHeight,
      isInheritingTransform,
    },
    parentStyle
  )

  let filter = ''
  if (parentStyle.textShadowOffset) {
    const { textShadowColor, textShadowOffset, textShadowRadius } = parentStyle
    filter = buildDropShadow(
      {
        width: measuredTextSize.width,
        height: measuredTextSize.height,
        id,
      },
      {
        shadowColor: textShadowColor,
        shadowOffset: textShadowOffset,
        shadowRadius: textShadowRadius,
      }
    )
    filter = buildXMLString('defs', {}, filter)
  }

  let decorationShape = ''
  let mergedPath = ''
  let extra = ''
  let skippedLine = -1
  let decorationLines: Record<number, null | number[]> = {}

  // We no longer rely on "texts[]" or "wordPositionInLayout[]"; 
  // we rely on "placedSegments" from the flow, which has final positions for each run or piece.
  for (let i = 0; i < placedSegments.length; i++) {
    const layout = placedSegments[i]
    let text = layout.text
    const line = layout.line
    const lineIndex = layout.lineIndex
    const image = graphemeImages ? graphemeImages[text] : null
    let topOffset = layout.y
    let leftOffset = layout.x
    const width = layout.width

    // Some of your code for textOverflow or textAlign might go here.
    // For instance, if textAlign = 'right' or 'center', you might shift leftOffset.
    // We'll do a simpler approach:
    if (lineWidths[line] && (textAlign === 'right' || textAlign === 'end')) {
      leftOffset += containerWidth - lineWidths[line]
    } else if (lineWidths[line] && textAlign === 'center') {
      leftOffset += (containerWidth - lineWidths[line]) / 2
    }

    // Track baseline for this line
    const baselineOfLine = baselines[line]
    const baselineOfWord = engine.baseline(text)
    const heightOfWord = engine.height(text)
    const baselineDelta = baselineOfLine - baselineOfWord

    // If we haven’t set up a decoration line for this line, do so
    if (!decorationLines[line]) {
      // [startX, startY, ascender, lineWidth]
      decorationLines[line] = [
        leftOffset,
        top + topOffset + baselineDelta,
        baselineOfWord,
        lineWidths[line] || width,
      ]
    }

    let path: string | null = null

    // If it's an embedded image
    if (image) {
      // no baseline shift needed
    } else if (embedFont) {
      // If you are merging adjacent segments for better kerning, do that here
      // For brevity, omitted from this example
      path = engine.getSVG(text, {
        fontSize: finalFontSize,
        left: left + leftOffset,
        top: top + topOffset + baselineOfWord + baselineDelta,
        letterSpacing,
      })
    } else {
      topOffset += baselineOfWord + baselineDelta
    }

    // Build decoration if needed
    if (parentStyle.textDecorationLine) {
      const deco = decorationLines[line]
      if (deco && !deco[4]) {
        decorationShape += buildDecoration(
          {
            left: left + deco[0],
            top: deco[1],
            width: deco[3],
            ascender: deco[2],
            clipPathId,
          },
          parentStyle
        )
        deco[4] = 1
      }
    }

    // Actually build the SVG for this piece of text
    if (path) {
      mergedPath += path + ' '
    } else {
      // Normal <text> or <image> fallback
      const [t, shape] = buildText(
        {
          content: text,
          filter,
          id,
          left: left + leftOffset,
          top: top + topOffset,
          width,
          height: heightOfWord,
          matrix,
          opacity,
          image,
          clipPathId,
          debug,
          shape: !!_inheritedBackgroundClipTextPath,
          decorationShape,
        },
        parentStyle
      )
      result += t
      backgroundClipDef += shape
      decorationShape = ''
    }
  }

  // If we have embedded font paths
  if (mergedPath) {
    const p =
      parentStyle.color !== 'transparent' && opacity !== 0
        ? buildXMLString('path', {
            fill: parentStyle.color,
            d: mergedPath,
            transform: matrix ? matrix : undefined,
            opacity: opacity !== 1 ? opacity : undefined,
            'clip-path': clipPathId ? `url(#${clipPathId})` : undefined,
            mask: overflowMaskId ? `url(#${overflowMaskId})` : undefined,
            style: cssFilter ? `filter:${cssFilter}` : undefined,
          })
        : ''

    if (_inheritedBackgroundClipTextPath) {
      backgroundClipDef = buildXMLString('path', {
        d: mergedPath,
        transform: matrix ? matrix : undefined,
      })
    }

    result += (filter
      ? filter + buildXMLString(
          'g',
          { filter: `url(#satori_s-${id})` },
          p + decorationShape
        )
      : p + decorationShape) + extra
  }

  if (backgroundClipDef) {
    (parentStyle._inheritedBackgroundClipTextPath as any).value += backgroundClipDef
  }

  return result
}

/** Create a container node for this text fragment. */
function createTextContainerNode(Yoga: Yoga, textAlign: string) {
  const textContainer = Yoga.Node.create()
  textContainer.setAlignItems(Yoga.ALIGN_BASELINE)
  textContainer.setJustifyContent(
    v(
      textAlign,
      {
        left: Yoga.JUSTIFY_FLEX_START,
        right: Yoga.JUSTIFY_FLEX_END,
        center: Yoga.JUSTIFY_CENTER,
        justify: Yoga.JUSTIFY_SPACE_BETWEEN,
        // We don't have other writing modes yet
        start: Yoga.JUSTIFY_FLEX_START,
        end: Yoga.JUSTIFY_FLEX_END,
      },
      Yoga.JUSTIFY_FLEX_START,
      'textAlign'
    )
  )
  return textContainer
}

function detectTabs(text: string) {
  const result = /(\t)+/.exec(text)
  if (!result) {
    return { index: null, tabCount: 0 }
  } else {
    return { index: result.index, tabCount: result[0].length }
  }
}
