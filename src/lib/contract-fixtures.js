// Small deterministic examples complement, but never replace, the game's dummy
// validator. Randomized independent oracles live in the Node regression suite.
export function contractFixtures() {
	const root = 10n ** 100n + 123n;
	return {
		"Find Largest Prime Factor": [[13195, 29], [2, 2], [49, 7]],
		"Subarray with Maximum Sum": [[[-4, -2, -9], -2], [[-2, 3, 4, -1], 7]],
		"Total Ways to Sum": [[4, 4], [1, 0]],
		"Total Ways to Sum II": [[[10, [2, 5, 3, 6]], 5]],
		"Spiralize Matrix": [[[[1, 2, 3], [4, 5, 6]], [1, 2, 3, 6, 5, 4]]],
		"Array Jumping Game": [[[1, 0, 1], 0], [[2, 0, 0], 1], [[0], 1]],
		"Array Jumping Game II": [[[2, 3, 1, 1, 4], 2], [[1, 0, 1], 0], [[0], 0]],
		"Merge Overlapping Intervals": [[[[5, 7], [1, 3], [3, 6]], [[1, 7]]]],
		"Generate IP Addresses": [["25525511135", ["255.255.11.135", "255.255.111.35"]], ["0000", ["0.0.0.0"]]],
		"Algorithmic Stock Trader I": [[[7, 1, 5, 3, 6, 4], 5]],
		"Algorithmic Stock Trader II": [[[7, 1, 5, 3, 6, 4], 7]],
		"Algorithmic Stock Trader III": [[[3, 3, 5, 0, 0, 3, 1, 4], 6]],
		"Algorithmic Stock Trader IV": [[[2, [3, 2, 6, 5, 0, 3]], 7]],
		"Minimum Path Sum in a Triangle": [[[[2], [3, 4], [6, 5, 7], [4, 1, 8, 3]], 11]],
		"Unique Paths in a Grid I": [[[3, 7], 28], [[1, 1], 1]],
		"Unique Paths in a Grid II": [[[[0, 0, 0], [0, 1, 0], [0, 0, 0]], 2], [[[1]], 0]],
		"Shortest Path in a Grid": [[[[0, 1], [0, 0]], "DR"], [[[0, 1], [1, 0]], ""], [[[0]], ""]],
		"Sanitize Parentheses in Expression": [["()())()", ["(())()", "()()()"]], [")(", [""]]],
		"Find All Valid Math Expressions": [[["105", 5], ["1*0+5", "10-5"]], [["00", 0], ["0+0", "0-0", "0*0"]]],
		"HammingCodes: Integer to Encoded Binary": [[8, "11110000"], [21, "1001101011"]],
		"HammingCodes: Encoded Binary to Integer": [["1001101010", 21], ["01110000", 8]],
		"Proper 2-Coloring of a Graph": [[[3, [[0, 1], [1, 2]]], [0, 1, 0]], [[3, [[0, 1], [1, 2], [2, 0]]], []]],
		"Compression I: RLE Compression": [["aaaaaaaaaaa", "9a2a"], ["111112333", "511233"]],
		"Compression II: LZ Decompression": [["5aaabb450723abb", "aaabbaaababababaabb"], ["1a91031", "aaaaaaaaaaaaa"]],
		"Compression III: LZ Compression": [["abracadabra", "7abracad47"], ["aaaaaaaaaaaaa", "1a31091"]],
		"Encryption I: Caesar Cipher": [[["ABC XYZ", 3], "XYZ UVW"]],
		"Encryption II: Vigenère Cipher": [[["ATTACKATDAWN", "LEMON"], "LXFOPVEFRNHR"], [["A A", "BC"], "B B"]],
		"Square Root": [[0n, "0"], [3n, "2"], [6n, "2"], [7n, "3"], [root * root + root, root.toString()], [root * root + root + 1n, (root + 1n).toString()]],
		"Total Number of Primes": [[[0, 20], 8], [[2, 2], 1], [[0, 1], 0]],
		"Largest Rectangle in a Matrix": [[[[1, 0, 0], [0, 0, 0]], [[0, 1], [1, 2]]]],
	};
}

export function fixtureMatches(type, actual, expected) {
	const unordered = ["Sanitize Parentheses in Expression", "Find All Valid Math Expressions", "Generate IP Addresses"];
	if (unordered.includes(type)) {
		if (!Array.isArray(actual)) return false;
		return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
	}
	return JSON.stringify(actual) === JSON.stringify(expected);
}
