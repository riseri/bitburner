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
});

export function solveContract(type, data) {
	const solver = SOLVERS[type];
	if (!solver) {
		return { supported: false, answer: null };
	}

	return {
		supported: true,
		answer: solver(structuredClone(data)),
	};
}

function largestPrimeFactor(value) {
	let n = Number(value);
	let factor = 2;
	let largest = 1;
	while (factor * factor <= n) {
		while (n % factor === 0) {
			largest = factor;
			n /= factor;
		}
		factor += factor === 2 ? 1 : 2;
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
	let index = 0;
	return text.replace(/[A-Z]/g, char => {
		const shift = key.charCodeAt(index++ % key.length) - 65;
		return String.fromCharCode(65 + (char.charCodeAt(0) - 65 + shift) % 26);
	});
}

function squareRoot(value) {
	const n = BigInt(value);
	if (n < 2n) return n.toString();
	let x = 1n << (BigInt(n.toString(2).length) + 1n >> 1n);
	while (true) {
		const y = (x + n / x) >> 1n;
		if (y >= x) return x.toString();
		x = y;
	}
}
