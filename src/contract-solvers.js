// Bump on algorithm changes; certificates also bind to the exact source bytes.
export const SOLVER_VERSION = "contracts-v2";

export const SOLVERS = Object.freeze({
	"Find Largest Prime Factor": largestPrimeFactor,
	"Subarray with Maximum Sum": maximumSubarray,
	"Total Ways to Sum": totalWaysToSum,
	"Total Ways to Sum II": totalWaysToSumII,
	"Spiralize Matrix": spiralizeMatrix,
	"Array Jumping Game": arrayJumpingGame,
	"Array Jumping Game II": arrayJumpingGameII,
	"Merge Overlapping Intervals": mergeIntervals,
	"Generate IP Addresses": generateIpAddresses,
	"Algorithmic Stock Trader I": stockTraderI,
	"Algorithmic Stock Trader II": stockTraderII,
	"Algorithmic Stock Trader III": stockTraderIII,
	"Algorithmic Stock Trader IV": stockTraderIV,
	"Minimum Path Sum in a Triangle": minimumTrianglePath,
	"Unique Paths in a Grid I": uniquePathsI,
	"Unique Paths in a Grid II": uniquePathsII,
	"Proper 2-Coloring of a Graph": properTwoColoring,
	"Compression I: RLE Compression": rleCompress,
	"Encryption I: Caesar Cipher": caesarCipher,
	"Encryption II: Vigenère Cipher": vigenereCipher,
	"Square Root": squareRoot,
	"Shortest Path in a Grid": shortestPath,
	"Sanitize Parentheses in Expression": sanitizeParentheses,
	"Find All Valid Math Expressions": mathExpressions,
	"HammingCodes: Integer to Encoded Binary": hammingEncode,
	"HammingCodes: Encoded Binary to Integer": hammingDecode,
	"Compression II: LZ Decompression": lzDecompress,
	"Compression III: LZ Compression": lzCompress,
	"Total Number of Primes": totalPrimes,
	"Largest Rectangle in a Matrix": largestRectangle,
});

export function solveContract(type, data) {
	const solver = Object.hasOwn(SOLVERS, type) ? SOLVERS[type] : null;
	if (!solver) {
		return { supported: false, answer: null };
	}

	return {
		supported: true,
		answer: solver(structuredClone(data)),
	};
}

function largestPrimeFactor(value) {
	return finish(largestPrimeFactorSteps(value));
}

function* largestPrimeFactorSteps(value) {
	let n = Number(value);
	if (!Number.isSafeInteger(n) || n < 2) throw new Error("Expected an integer >= 2");
	let largest = 1, work = 0;
	for (let factor = 2; factor * factor <= n; factor += factor === 2 ? 1 : 2) {
		while (n % factor === 0) { largest = factor; n /= factor; }
		if (++work % 512 === 0) yield;
	}
	return Math.max(largest, n);
}

function maximumSubarray(values) {
	let best = values[0];
	let current = values[0];
	for (let i = 1; i < values.length; i++) {
		current = Math.max(values[i], current + values[i]);
		best = Math.max(best, current);
	}
	return best;
}

function totalWaysToSum(n) {
	const dp = Array(n + 1).fill(0);
	dp[0] = 1;
	for (let part = 1; part < n; part++) {
		for (let sum = part; sum <= n; sum++) {
			dp[sum] += dp[sum - part];
		}
	}
	return dp[n];
}

function totalWaysToSumII([target, values]) {
	const dp = Array(target + 1).fill(0);
	dp[0] = 1;
	for (const value of values) {
		for (let sum = value; sum <= target; sum++) {
			dp[sum] += dp[sum - value];
		}
	}
	return dp[target];
}

function spiralizeMatrix(matrix) {
	const result = [];
	let top = 0;
	let bottom = matrix.length - 1;
	let left = 0;
	let right = matrix[0].length - 1;

	while (top <= bottom && left <= right) {
		for (let col = left; col <= right; col++) result.push(matrix[top][col]);
		top++;
		for (let row = top; row <= bottom; row++) result.push(matrix[row][right]);
		right--;
		if (top <= bottom) {
			for (let col = right; col >= left; col--) result.push(matrix[bottom][col]);
			bottom--;
		}
		if (left <= right) {
			for (let row = bottom; row >= top; row--) result.push(matrix[row][left]);
			left++;
		}
	}
	return result;
}

function arrayJumpingGame(values) {
	let reach = 0;
	for (let i = 0; i <= reach && i < values.length; i++) {
		reach = Math.max(reach, i + values[i]);
		if (reach >= values.length - 1) return 1;
	}
	return values.length <= 1 ? 1 : 0;
}

function arrayJumpingGameII(values) {
	if (values.length <= 1) return 0;
	let jumps = 0;
	let currentEnd = 0;
	let farthest = 0;
	for (let i = 0; i < values.length - 1; i++) {
		farthest = Math.max(farthest, i + values[i]);
		if (i === currentEnd) {
			if (farthest <= i) return 0;
			jumps++;
			currentEnd = farthest;
			if (currentEnd >= values.length - 1) return jumps;
		}
	}
	return 0;
}

function mergeIntervals(intervals) {
	if (!intervals.length) return [];
	intervals.sort((a, b) => a[0] - b[0]);
	const merged = [intervals[0].slice()];
	for (let i = 1; i < intervals.length; i++) {
		const last = merged[merged.length - 1];
		const next = intervals[i];
		if (next[0] <= last[1]) {
			last[1] = Math.max(last[1], next[1]);
		} else {
			merged.push(next.slice());
		}
	}
	return merged;
}

function generateIpAddresses(text) {
	const result = [];
	for (let a = 1; a <= 3; a++) {
		for (let b = 1; b <= 3; b++) {
			for (let c = 1; c <= 3; c++) {
				const d = text.length - a - b - c;
				if (d < 1 || d > 3) continue;
				const parts = [
					text.slice(0, a),
					text.slice(a, a + b),
					text.slice(a + b, a + b + c),
					text.slice(a + b + c),
				];
				if (parts.every(validIpPart)) result.push(parts.join("."));
			}
		}
	}
	return result;
}

function validIpPart(part) {
	return !(part.length > 1 && part[0] === "0") && Number(part) <= 255;
}

function stockTraderI(prices) {
	let low = Infinity;
	let best = 0;
	for (const price of prices) {
		low = Math.min(low, price);
		best = Math.max(best, price - low);
	}
	return best;
}

function stockTraderII(prices) {
	let profit = 0;
	for (let i = 1; i < prices.length; i++) {
		profit += Math.max(0, prices[i] - prices[i - 1]);
	}
	return profit;
}

function stockTraderIII(prices) {
	return maxProfitWithTransactions(2, prices);
}

function stockTraderIV([transactions, prices]) {
	return maxProfitWithTransactions(transactions, prices);
}

function maxProfitWithTransactions(k, prices) {
	if (!prices.length || k <= 0) return 0;
	if (k >= prices.length / 2) return stockTraderII(prices);
	const hold = Array(k + 1).fill(-Infinity);
	const cash = Array(k + 1).fill(0);
	for (const price of prices) {
		for (let t = 1; t <= k; t++) {
			hold[t] = Math.max(hold[t], cash[t - 1] - price);
			cash[t] = Math.max(cash[t], hold[t] + price);
		}
	}
	return cash[k];
}

function minimumTrianglePath(triangle) {
	const dp = triangle[triangle.length - 1].slice();
	for (let row = triangle.length - 2; row >= 0; row--) {
		for (let col = 0; col < triangle[row].length; col++) {
			dp[col] = triangle[row][col] + Math.min(dp[col], dp[col + 1]);
		}
	}
	return dp[0];
}

function uniquePathsI([rows, cols]) {
	const dp = Array(cols).fill(1);
	for (let row = 1; row < rows; row++) {
		for (let col = 1; col < cols; col++) dp[col] += dp[col - 1];
	}
	return dp[cols - 1];
}

function uniquePathsII(grid) {
	const cols = grid[0].length;
	const dp = Array(cols).fill(0);
	dp[0] = grid[0][0] === 0 ? 1 : 0;
	for (let row = 0; row < grid.length; row++) {
		for (let col = 0; col < cols; col++) {
			if (grid[row][col] === 1) dp[col] = 0;
			else if (col > 0) dp[col] += dp[col - 1];
		}
	}
	return dp[cols - 1];
}

function properTwoColoring([vertexCount, edges]) {
	const graph = Array.from({ length: vertexCount }, () => []);
	for (const [a, b] of edges) {
		graph[a].push(b);
		graph[b].push(a);
	}
	const colors = Array(vertexCount).fill(-1);
	for (let start = 0; start < vertexCount; start++) {
		if (colors[start] !== -1) continue;
		colors[start] = 0;
		const queue = [start];
		for (let i = 0; i < queue.length; i++) {
			const node = queue[i];
			for (const next of graph[node]) {
				if (colors[next] === -1) {
					colors[next] = 1 - colors[node];
					queue.push(next);
				} else if (colors[next] === colors[node]) {
					return [];
				}
			}
		}
	}
	return colors;
}

function rleCompress(text) {
	let result = "";
	for (let i = 0; i < text.length;) {
		let count = 1;
		while (i + count < text.length && text[i + count] === text[i] && count < 9) count++;
		result += `${count}${text[i]}`;
		i += count;
	}
	return result;
}

function caesarCipher([text, shift]) {
	return text.replace(/[A-Z]/g, char => {
		const code = char.charCodeAt(0) - 65;
		return String.fromCharCode(65 + (code - shift + 26) % 26);
	});
}

function vigenereCipher([text, key]) {
	if (!/^[A-Z]+$/.test(key)) throw new Error("Expected an uppercase keyword");
	// Upstream indexes the keyword by character position, including spaces.
	return [...text].map((char, i) => char === " " ? char :
		String.fromCharCode(65 + (char.charCodeAt(0) + key.charCodeAt(i % key.length) - 130) % 26)).join("");
}

function squareRoot(value) {
	const n = BigInt(value);
	if (n < 0n) throw new Error("Square Root requires a nonnegative integer");
	if (n < 2n) return n.toString();
	let x = 1n << ((BigInt(n.toString(2).length) + 1n) >> 1n);
	while (true) {
		const y = (x + n / x) >> 1n;
		if (y >= x) break;
		x = y;
	}
	// x is floor(sqrt(n)). Compare against the half-integer boundary without floats.
	return (n - x * x > x ? x + 1n : x).toString();
}

function finish(iterator) {
	let step;
	do { step = iterator.next(); } while (!step.done);
	return step.value;
}

// Heavy searches yield in bounded work slices. Heartbeats cannot help if a
// synchronous solver monopolizes the same JavaScript event loop as the JIT.
export async function solveContractAsync(type, data, yieldControl = async () => {}) {
	const steps = {
		"Find Largest Prime Factor": largestPrimeFactorSteps,
		"Find All Valid Math Expressions": mathExpressionSteps,
		"Sanitize Parentheses in Expression": sanitizeSteps,
		"Total Number of Primes": primeSteps,
		"Compression III: LZ Compression": lzSteps,
	};
	if (!Object.hasOwn(SOLVERS, type)) return { supported: false, answer: null };
	await yieldControl();
	if (!Object.hasOwn(steps, type)) return solveContract(type, data);
	const iterator = steps[type](structuredClone(data));
	while (true) {
		const step = iterator.next();
		if (step.done) return { supported: true, answer: step.value };
		await yieldControl();
	}
}

function shortestPath(grid) {
	const rows = grid.length, cols = grid[0].length;
	if (grid[0][0] || grid[rows - 1][cols - 1]) return "";
	const queue = [0], parent = Array(rows * cols).fill(-1), moves = [];
	parent[0] = 0;
	for (let head = 0; head < queue.length; head++) {
		const at = queue[head], r = Math.floor(at / cols), c = at % cols;
		if (at === rows * cols - 1) {
			let path = "", end = at;
			while (end !== 0) { path = moves[end] + path; end = parent[end]; }
			return path;
		}
		for (const [dr, dc, move] of [[1, 0, "D"], [0, 1, "R"], [-1, 0, "U"], [0, -1, "L"]]) {
			const nr = r + dr, nc = c + dc, next = nr * cols + nc;
			if (nr < 0 || nc < 0 || nr >= rows || nc >= cols || grid[nr][nc] || parent[next] !== -1) continue;
			parent[next] = at; moves[next] = move; queue.push(next);
		}
	}
	return "";
}

function sanitizeParentheses(text) { return finish(sanitizeSteps(text)); }

function* sanitizeSteps(text) {
	let left = 0, right = 0, work = 0;
	for (const char of text) {
		if (char === "(") left++;
		if (char === ")") { if (left) left--; else right++; }
	}
	const answers = new Set();
	function* visit(i, balance, removeLeft, removeRight, path) {
		if (++work % 512 === 0) yield;
		if (removeLeft + removeRight > text.length - i) return;
		if (i === text.length) {
			if (!balance && !removeLeft && !removeRight) answers.add(path);
			return;
		}
		const char = text[i];
		if (char === "(") {
			if (removeLeft) yield* visit(i + 1, balance, removeLeft - 1, removeRight, path);
			yield* visit(i + 1, balance + 1, removeLeft, removeRight, path + char);
		} else if (char === ")") {
			if (removeRight) yield* visit(i + 1, balance, removeLeft, removeRight - 1, path);
			if (balance) yield* visit(i + 1, balance - 1, removeLeft, removeRight, path + char);
		} else yield* visit(i + 1, balance, removeLeft, removeRight, path + char);
	}
	yield* visit(0, 0, left, right, "");
	return [...answers].sort();
}

function mathExpressions(data) { return finish(mathExpressionSteps(data)); }

function* mathExpressionSteps([digits, target]) {
	if (!/^\d{1,12}$/.test(digits)) throw new Error("Expected 1..12 digits");
	const answers = [];
	let work = 0;
	function* visit(pos, value, last, path) {
		if (++work % 512 === 0) yield;
		if (pos === digits.length) { if (value === target) answers.push(path); return; }
		for (let end = pos + 1; end <= digits.length; end++) {
			if (end > pos + 1 && digits[pos] === "0") break;
			const token = digits.slice(pos, end), n = Number(token);
			if (!pos) yield* visit(end, n, n, token);
			else {
				yield* visit(end, value + n, n, path + "+" + token);
				yield* visit(end, value - n, -n, path + "-" + token);
				// Replace the previous term, preserving multiplication precedence.
				yield* visit(end, value - last + last * n, last * n, path + "*" + token);
			}
		}
	}
	yield* visit(0, 0, 0, "");
	return answers;
}

function hammingEncode(value) {
	if (!Number.isInteger(value) || value < 0 || !Number.isFinite(value)) throw new Error("Expected a nonnegative integer");
	const data = value.toString(2), bits = [0];
	for (let i = 1, j = 0; j < data.length; i++) bits[i] = (i & (i - 1)) === 0 ? 0 : Number(data[j++]);
	for (let parity = 1; parity < bits.length; parity *= 2) {
		let bit = 0;
		for (let i = 1; i < bits.length; i++) if (i & parity) bit ^= bits[i];
		bits[parity] = bit;
	}
	bits[0] = bits.reduce((a, b) => a ^ b, 0);
	return bits.join("");
}

function hammingDecode(encoded) {
	if (!/^[01]+$/.test(encoded)) throw new Error("Expected a binary string");
	const bits = [...encoded].map(Number);
	let syndrome = 0, parity = 0;
	for (let i = 0; i < bits.length; i++) { if (bits[i]) syndrome ^= i; parity ^= bits[i]; }
	if (syndrome >= bits.length || (syndrome && !parity)) throw new Error("Uncorrectable Hamming code");
	if (parity) bits[syndrome] ^= 1;
	let data = "";
	for (let i = 1; i < bits.length; i++) if (i & (i - 1)) data += bits[i];
	return parseInt(data || "0", 2);
}

function lzDecompress(encoded) {
	let plain = "", literal = true;
	for (let i = 0; i < encoded.length; literal = !literal) {
		if (!/[0-9]/.test(encoded[i])) throw new Error("Invalid LZ length");
		const length = Number(encoded[i++]);
		if (!length) continue;
		if (literal) {
			if (i + length > encoded.length) throw new Error("Truncated LZ literal");
			plain += encoded.slice(i, i + length); i += length;
		} else {
			const offset = Number(encoded[i++]);
			if (!(offset >= 1 && offset <= 9 && offset <= plain.length)) throw new Error("Invalid LZ offset");
			for (let j = 0; j < length; j++) plain += plain[plain.length - offset];
		}
	}
	return plain;
}

function lzCompress(plain) { return finish(lzSteps(plain)); }

function* lzSteps(plain) {
	// Suffix DP: only (position, next chunk type) matters. A zero chunk switches
	// type; two consecutive zero chunks can never improve a shortest encoding.
	const dp = Array.from({ length: plain.length + 1 }, () => ["", ""]);
	const better = (a, b) => b !== null && (a === null || b.length < a.length || (b.length === a.length && b < a)) ? b : a;
	for (let i = plain.length - 1; i >= 0; i--) {
		let literal = null, reference = null;
		for (let n = 1; n <= 9 && i + n <= plain.length; n++) {
			literal = better(literal, n + plain.slice(i, i + n) + dp[i + n][1]);
		}
		for (let offset = 1; offset <= 9 && offset <= i; offset++) {
			for (let n = 1; n <= 9 && i + n <= plain.length; n++) {
				if (plain[i + n - 1] !== plain[i + n - 1 - offset]) break;
				reference = better(reference, `${n}${offset}` + dp[i + n][0]);
			}
		}
		dp[i][0] = better(literal, reference === null ? null : "0" + reference);
		dp[i][1] = better(reference, "0" + literal);
		yield;
	}
	return dp[0][0];
}

function totalPrimes(range) { return finish(primeSteps(range)); }

function* primeSteps([low, high]) {
	if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high) || low < 0 || high < low || high > 6_000_000) {
		throw new Error("Prime range outside supported game bounds");
	}
	low = Math.max(2, low);
	if (high < low) return 0;
	const limit = Math.floor(Math.sqrt(high)), base = new Uint8Array(limit + 1);
	const composite = new Uint8Array(high - low + 1);
	let work = 0, count = 0;
	for (let p = 2; p <= limit; p++) {
		if (base[p]) continue;
		for (let n = p * p; n <= limit; n += p) base[n] = 1;
		for (let n = Math.max(p * p, Math.ceil(low / p) * p); n <= high; n += p) {
			composite[n - low] = 1;
			if (++work % 2048 === 0) yield;
		}
	}
	for (let i = 0; i < composite.length; i++) {
		if (!composite[i]) count++;
		if (++work % 2048 === 0) yield;
	}
	return count;
}

function largestRectangle(grid) {
	const heights = Array(grid[0].length).fill(0);
	let bestArea = 0, corners = null;
	for (let r = 0; r < grid.length; r++) {
		for (let c = 0; c < heights.length; c++) heights[c] = grid[r][c] === 0 ? heights[c] + 1 : 0;
		const stack = [];
		for (let c = 0; c <= heights.length; c++) {
			const height = c === heights.length ? 0 : heights[c];
			let left = c;
			while (stack.length && stack[stack.length - 1][1] > height) {
				const [start, h] = stack.pop(); left = start;
				if (h * (c - start) > bestArea) {
					bestArea = h * (c - start); corners = [[r - h + 1, start], [r, c - 1]];
				}
			}
			if (height && (!stack.length || stack[stack.length - 1][1] < height)) stack.push([left, height]);
		}
	}
	if (!corners) throw new Error("Matrix has no zero rectangle");
	return corners;
}
