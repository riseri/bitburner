const DIGITS = "0123456789";
const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DEFAULT_PASSWORDS = ["admin", "password", "0000", "12345"];
const DOG_NAMES = ["fido", "spot", "rover", "max"];
const EU_COUNTRIES = ["Austria", "Belgium", "Bulgaria", "Croatia", "Republic of Cyprus", "Czech Republic", "Denmark", "Estonia", "Finland", "France", "Germany", "Greece", "Hungary", "Ireland", "Italy", "Latvia", "Lithuania", "Luxembourg", "Malta", "Netherlands", "Poland", "Portugal", "Romania", "Slovakia", "Slovenia", "Spain", "Sweden"];
const COMMON_PASSWORDS = ["123456", "password", "12345678", "qwerty", "123456789", "12345", "1234", "111111", "1234567", "dragon", "123123", "baseball", "abc123", "football", "monkey", "letmein", "696969", "shadow", "master", "666666", "qwertyuiop", "123321", "mustang", "1234567890", "michael", "654321", "superman", "1qaz2wsx", "7777777", "121212", "0", "qazwsx", "123qwe", "trustno1", "jordan", "jennifer", "zxcvbnm", "asdfgh", "hunter", "buster", "soccer", "harley", "batman", "andrew", "tigger", "sunshine", "iloveyou", "2000", "charlie", "robert", "thomas", "hockey", "ranger", "daniel", "starwars", "112233", "george", "computer", "michelle", "jessica", "pepper", "1111", "zxcvbn", "555555", "11111111", "131313", "freedom", "777777", "pass", "maggie", "159753", "aaaaaa", "ginger", "princess", "joshua", "cheese", "amanda", "summer", "love", "ashley", "6969", "nicole", "chelsea", "biteme", "matthew", "access", "yankees", "987654321", "dallas", "austin", "thunder", "taylor", "matrix"];
const LARGE_PRIMES = [1069,1409,1471,1567,1597,1601,1697,1747,1801,1889,1979,1999,2063,2207,2371,2503,2539,2693,2741,2753,2801,2819,2837,2909,2939,3169,3389,3571,3761,3881,4217,4289,4547,4729,4789,4877,4943,4951,4957,5393,5417,5419,5441,5519,5527,5647,5779,5881,6007,6089,6133,6389,6451,6469,6547,6661,6719,6841,7103,7549,7559,7573,7691,7753,7867,8053,8081,8221,8329,8599,8677,8761,8839,8963,9103,9199,9343,9467,9551,9601,9739,9749,9859];

export function alphabetFor(format) {
	if (format === "numeric") return DIGITS;
	if (format === "alphabetic") return LETTERS;
	if (format === "alphanumeric") return DIGITS + LETTERS;
	return DIGITS + LETTERS + "!@#$%^&*()_+-=[]{}|;:,.<>?";
}

export function staticCandidates(details) {
	const data = String(details.data ?? ""), hint = String(details.passwordHint ?? "");
	switch (details.modelId) {
		case "ZeroLogon": return [""];
		case "DeskMemo_3.1": return [hint.match(/(-?\d+)\s*$/)?.[1]].filter(v => v != null);
		case "CloudBlare(tm)": return [data.replace(/\D/g, "")];
		case "FreshInstall_1.0": return DEFAULT_PASSWORDS;
		case "Laika4": return DOG_NAMES;
		case "TopPass": return COMMON_PASSWORDS;
		case "EuroZone Free": return EU_COUNTRIES;
		case "110100100": return [data.split(/\s+/).filter(Boolean).map(bits => String.fromCharCode(parseInt(bits, 2))).join("")];
		case "PrimeTime 2": return [String(largestPrimeFactor(Number(data)))];
		case "OctantVoxel": { const [base, encoded] = data.split(","); return [String(parseBase(encoded, Number(base)))]; }
		case "MathML": return [String(evaluateArithmetic(data))];
		case "OrdoXenos": return [decodeXor(data)];
		case "Pr0verFl0": return ["■".repeat(Math.max(2, 2 * Number(details.passwordLength || 1)))];
		default: return [];
	}
}

export function parsePasswordResponse(logs, attempted) {
	for (const raw of logs || []) {
		try {
			const value = typeof raw === "string" ? JSON.parse(raw) : raw;
			if (value && typeof value === "object" && value.passwordAttempted === attempted) return value;
		} catch {}
	}
	return null;
}

export async function solveServer(ns, host, details, options = {}) {
	const attempted = new Set(), maxAttempts = Math.max(10, Number(options.maxAttempts) || 400);
	const attempt = async password => {
		password = String(password ?? "");
		if (attempted.has(password) || attempted.size >= maxAttempts) return { success: false, duplicate: true };
		attempted.add(password);
		for (let retry = 0; retry < 3; retry++) {
			const result = await ns.dnet.authenticate(host, password);
			if (result.success) return { success: true, password, result };
			if (result.code !== 408) return { success: false, password, result };
		}
		return { success: false, password, result: { code: 408 } };
	};
	const feedback = async password => {
		const result = await attempt(password);
		if (result.success || result.duplicate) return { ...result, response: null };
		const bleed = await ns.dnet.heartbleed(host, { peek: true, logsToCapture: 20 });
		return { ...result, response: bleed.success ? parsePasswordResponse(bleed.logs, String(password)) : null, bleed };
	};

	for (const candidate of staticCandidates(details)) { const r = await attempt(candidate); if (r.success) return solved(r, attempted); }
	let result;
	switch (details.modelId) {
		case "PHP 5.4": result = await solveSorted(details, feedback); break;
		case "DeepGreen": result = await solveExactOracle(details, feedback, true); break;
		case "AccountsManager_4.2": result = await solveOrderedNumber(details, feedback, "Lower", "Higher"); break;
		case "BellaCuore": result = await solveRoman(details, feedback); break;
		case "NIL": result = await solveYesnt(details, feedback); break;
		case "RateMyPix.Auth": result = await solveExactOracle(details, feedback, false); break;
		case "2G_cellular": result = await solveTiming(details, feedback); break;
		case "Factori-Os": result = await solveDivisibility(details, feedback); break;
		case "BigMo%od": result = await solveTripleModulo(details, feedback); break;
		case "KingOfTheHill": result = await solveHill(details, feedback); break;
		case "OpenWebAccessPoint": result = await solvePackets(host, details, feedback); break;
		case "(The Labyrinth)": result = await solveLabyrinth(feedback); break;
		default: result = null;
	}
	return result?.success ? solved(result, attempted) : { success: false, reason: result?.reason || "unsupported-or-feedback-unavailable", attempts: attempted.size };
}

function solved(result, attempted) { return { success: true, password: result.password, attempts: attempted.size }; }

async function solveOrderedNumber(details, feedback, lowerWord, higherWord, lo = 0, hi = null) {
	hi ??= 10 ** Number(details.passwordLength || 1) - 1;
	while (lo <= hi) {
		const mid = Math.floor((lo + hi) / 2), r = await feedback(String(mid));
		if (r.success) return r;
		const direction = String(r.response?.data ?? "");
		if (direction === lowerWord) hi = mid - 1;
		else if (direction === higherWord) lo = mid + 1;
		else return { success: false, reason: "feedback-unavailable" };
	}
	return { success: false, reason: "range-exhausted" };
}

async function solveRoman(details, feedback) {
	const parts = String(details.data || "").split(",");
	if (parts.length === 1) return feedback(String(romanToNumber(parts[0])));
	return solveOrderedNumber(details, feedback, "ALTUS NIMIS", "PARUM BREVIS", romanToNumber(parts[0]), romanToNumber(parts[1]));
}

async function solvePositionOracle(details, feedback, decode) {
	const n = Number(details.passwordLength), alphabet = alphabetFor(details.passwordFormat), answer = Array(n).fill(alphabet[0]);
	for (let i = 0; i < n; i++) {
		let found = false;
		for (const c of alphabet) {
			const guess = answer.map((v, j) => j < i ? v : j === i ? c : alphabet[0]).join("");
			const r = await feedback(guess); if (r.success) return r;
			const exact = decode(r.response);
			if (exact?.[i]) { answer[i] = c; found = true; break; }
		}
		if (!found) return { success: false, reason: `position-${i}-unresolved` };
	}
	return feedback(answer.join(""));
}

async function solveYesnt(details, feedback) {
	const n = Number(details.passwordLength), answer = Array(n).fill(null);
	for (const c of alphabetFor(details.passwordFormat)) {
		const r = await feedback(c.repeat(n)); if (r.success) return r;
		const exact = String(r.response?.data ?? "").split(",").map(value => value === "yes");
		if (exact.length !== n) return { success: false, reason: "feedback-unavailable" };
		for (let i = 0; i < n; i++) if (exact[i]) answer[i] = c;
		if (answer.every(value => value !== null)) return feedback(answer.join(""));
	}
	return { success: false, reason: "positions-unresolved" };
}

async function solveExactOracle(details, feedback, mastermind) {
	const n = Number(details.passwordLength), alphabet = alphabetFor(details.passwordFormat);
	let filler = null;
	const counts = new Map();
	for (const c of alphabet) {
		const r = await feedback(c.repeat(n)); if (r.success) return r;
		const raw = String(r.response?.data ?? ""), count = mastermind ? Number(raw.split(",")[0]) : (raw.match(/🌶️/g) || []).length;
		if (!Number.isFinite(count)) return { success: false, reason: "feedback-unavailable" };
		counts.set(c, count); if (count === 0 && filler === null) filler = c;
	}
	if (filler === null) return { success: false, reason: "no-filler-symbol" };
	const answer = Array(n).fill(filler), symbols = [...counts].filter(([, count]) => count > 0).map(([c]) => c);
	for (let i = 0; i < n; i++) for (const c of symbols) {
		const guess = [...answer]; guess[i] = c;
		const r = await feedback(guess.join("")); if (r.success) return r;
		const raw = String(r.response?.data ?? ""), exact = mastermind ? Number(raw.split(",")[0]) : (raw.match(/🌶️/g) || []).length;
		if (exact > answer.filter(v => v !== filler).length) { answer[i] = c; break; }
	}
	return feedback(answer.join(""));
}

async function solveTiming(details, feedback) {
	const n = Number(details.passwordLength), alphabet = alphabetFor(details.passwordFormat), answer = [];
	for (let i = 0; i < n; i++) {
		let found = false;
		for (const c of alphabet) {
			const guess = answer.join("") + c + alphabet[0].repeat(n - i - 1), r = await feedback(guess);
			if (r.success) return r;
			const mismatch = Number(String(r.response?.message ?? "").match(/\((-?\d+)\)/)?.[1]);
			if (mismatch > i || mismatch === -1) { answer.push(c); found = true; break; }
		}
		if (!found) return { success: false, reason: `timing-position-${i}-unresolved` };
	}
	return feedback(answer.join(""));
}

async function solveSorted(details, feedback) {
	const sorted = String(details.data || ""), n = sorted.length;
	if (n < 5) for (const candidate of uniquePermutations(sorted)) { const r = await feedback(candidate); if (r.success) return r; }
	const zero = "0".repeat(n), r0 = await feedback(zero); if (r0.success) return r0;
	const rms0 = rmsFrom(r0.response); if (!Number.isFinite(rms0)) return { success: false, reason: "rms-feedback-unavailable" };
	const answer = [];
	for (let i = 0; i < n; i++) {
		const probe = zero.slice(0, i) + "1" + zero.slice(i + 1), r = await feedback(probe); if (r.success) return r;
		const rms1 = rmsFrom(r.response), digit = Math.round((1 + n * (rms0 ** 2 - rms1 ** 2)) / 2);
		answer.push(String(Math.max(0, Math.min(9, digit))));
	}
	return feedback(answer.join(""));
}

async function solveDivisibility(details, feedback) {
	let product = 1n;
	for (const prime of [2,3,5,7,11,13,17,19,23,29,31,37,41,43,47,53,59,61,67,71,73,79,83,89,97,...LARGE_PRIMES]) {
		let power = BigInt(prime);
		while (String(power).length <= Number(details.passwordLength || 15)) {
			const r = await feedback(String(power)); if (r.success) return r;
			if (String(r.response?.data) !== "true") break;
			product *= BigInt(prime); power *= BigInt(prime);
		}
	}
	return feedback(String(product));
}

async function solveTripleModulo(details, feedback) {
	let x = 0n, modulus = 1n;
	for (const m of [31,29,23,19,17,13,11,7,5]) {
		const r = await feedback(String(m)); if (r.success) return r;
		const value = Number(r.response?.data);
		if (!Number.isInteger(value) || value < 0 || value >= m) return { success: false, reason: "feedback-unavailable" };
		const residue = BigInt(value);
		while (x % BigInt(m) !== residue) x += modulus;
		modulus *= BigInt(m);
		if (modulus >= 10n ** BigInt(Number(details.passwordLength || 1))) break;
	}
	return feedback(String(x));
}

async function solveHill(details, feedback) {
	const max = 10 ** Number(details.passwordLength || 1) - 1, samples = 100;
	let bestX = 0, bestY = -Infinity;
	for (let i = 0; i <= samples; i++) {
		const x = Math.round(max * i / samples), r = await feedback(String(x)); if (r.success) return r;
		const y = Number(r.response?.data); if (y > bestY) { bestY = y; bestX = x; }
	}
	let lo = Math.max(0, bestX - max / samples * 2), hi = Math.min(max, bestX + max / samples * 2);
	for (let i = 0; i < 35 && hi - lo > 1; i++) {
		const a = Math.floor(lo + (hi - lo) / 3), b = Math.ceil(hi - (hi - lo) / 3);
		const ra = await feedback(String(a)); if (ra.success) return ra; const rb = await feedback(String(b)); if (rb.success) return rb;
		if (Number(ra.response?.data) < Number(rb.response?.data)) lo = a; else hi = b;
	}
	for (let x = Math.max(0, Math.floor(lo) - 2); x <= Math.min(max, Math.ceil(hi) + 2); x++) { const r = await feedback(String(x)); if (r.success) return r; }
	return { success: false, reason: "peak-not-found" };
}

async function solvePackets(host, details, feedback) {
	const samples = [];
	for (let i = 0; i < 4; i++) { const r = await feedback(`probe-${i}`); if (r.success) return r; const data = String(r.response?.data ?? ""); if (data) samples.push(data); }
	const direct = samples.map(s => s.match(new RegExp(`(?:^|\\s)${escapeRegex(host)}:([^\\s]+)(?:\\s|$)`))?.[1]).find(Boolean);
	if (direct) return feedback(direct);
	const n = Number(details.passwordLength), first = samples[0] || "";
	for (let i = 0; i + n <= first.length; i++) {
		const candidate = first.slice(i, i + n);
		if (samples.slice(1).every(sample => sample.includes(candidate))) { const r = await feedback(candidate); if (r.success) return r; }
	}
	return { success: false, reason: "packet-password-not-found" };
}

async function solveLabyrinth(feedback) {
	const opposite = { north: "south", south: "north", east: "west", west: "east" }, stack = [], visited = new Set();
	let r = await feedback("look"); if (r.success) return r;
	for (let steps = 0; steps < 20000; steps++) {
		const coords = String(r.response?.message ?? "").match(/(?:at|to)\s+(\d+),(\d+)/), view = String(r.response?.data ?? "").split("\n");
		if (!coords || view.length < 3) return { success: false, reason: "labyrinth-feedback-unavailable" };
		const key = `${coords[1]},${coords[2]}`; visited.add(key);
		const choices = [["north",0,-2,view[0]?.[1]===" "],["east",2,0,view[1]?.[2]===" "],["south",0,2,view[2]?.[1]===" "],["west",-2,0,view[1]?.[0]===" "]]
			.filter(([,dx,dy,open]) => open && !visited.has(`${Number(coords[1])+dx},${Number(coords[2])+dy}`));
		let direction;
		if (choices.length) { direction = choices[0][0]; stack.push(opposite[direction]); }
		else { direction = stack.pop(); if (!direction) return { success: false, reason: "labyrinth-exhausted" }; }
		r = await feedback(`go ${direction}`); if (r.success) return { ...r, password: String(r.result?.data ?? "") };
	}
	return { success: false, reason: "labyrinth-step-limit" };
}

function largestPrimeFactor(value) { let n = value, largest = 1; for (let p = 2; p * p <= n; p += p === 2 ? 1 : 2) while (n % p === 0) { largest = p; n /= p; } return n > 1 ? n : largest; }
function romanToNumber(value) { if (String(value).toLowerCase() === "nulla") return 0; const map={I:1,V:5,X:10,L:50,C:100,D:500,M:1000}; let total=0,prev=0; for(const c of [...String(value)].reverse()){const v=map[c]||0; total+=v<prev?-v:v; prev=v;} return total; }
function parseBase(value, base) { const chars=DIGITS+"ABCDEFGHIJKLMNOPQRSTUVWXYZ"; let total=0,digit=String(value).split(".")[0].length-1; for(const c of String(value)){if(c!==".") total+=chars.indexOf(c)*base**digit--; } return total; }
function decodeXor(data) { const [encoded,masks=""] = String(data).split(";"); return [...encoded].map((c,i)=>String.fromCharCode(c.charCodeAt(0)^parseInt(masks.split(" ")[i]||"0",2))).join(""); }
function evaluateArithmetic(expression) { let safe=String(expression).replaceAll("ҳ","*").replaceAll("÷","/").replaceAll("➕","+").replaceAll("➖","-").replaceAll("ns.exit(),","").split(",")[0]; if(!/^[\d\s()+*/.\-]+$/.test(safe)) return NaN; return Function(`"use strict"; return (${safe})`)(); }
function rmsFrom(response) { return Number(String(response?.data ?? "").match(/RMS Deviation:([\d.]+)/)?.[1]); }
function uniquePermutations(value) { const out=[]; const walk=(prefix,rest)=>{if(!rest.length){out.push(prefix);return;} const used=new Set(); for(let i=0;i<rest.length;i++){if(used.has(rest[i]))continue;used.add(rest[i]);walk(prefix+rest[i],rest.slice(0,i)+rest.slice(i+1));}}; walk("",value); return out; }
function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g,"\\$&"); }
