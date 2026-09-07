import { NETWORK } from "../config";
// Encryption key custody for the testnet dapp: generated here, kept in localStorage, exported
// and imported by the user. Losing it means losing the ability to read AND spend the
// confidential balance (docs/01-design.md §2.7). In production this key is derived from the
// wallet seed inside WebAuth; the dapp never sends it anywhere.
import type { CryptoBackend, EncryptionKeypair, Hex } from "./crypto/types";

const KEY = (actor: string) => `pulse-privacy/enckey/v1/${actor}`;

export function loadKeypair(actor: string): EncryptionKeypair | null {
  try {
    const raw = localStorage.getItem(KEY(actor));
    if (!raw) return null;
    const kp = JSON.parse(raw) as EncryptionKeypair;
    if (!/^0x[0-9a-f]{64}$/.test(kp.secret) || !/^0x[0-9a-f]+$/.test(kp.pubkey)) return null;
    return kp;
  } catch {
    return null;
  }
}

export function saveKeypair(actor: string, kp: EncryptionKeypair) {
  localStorage.setItem(KEY(actor), JSON.stringify(kp));
}

export function forgetKeypair(actor: string) {
  localStorage.removeItem(KEY(actor));
}

const BACKED_UP = (actor: string) => `pulse-privacy/backedup/v1/${actor}`;
export const markBackedUp = (actor: string) => { try { localStorage.setItem(BACKED_UP(actor), "1"); } catch { /* ignore */ } };
export const isBackedUp = (actor: string) => { try { return localStorage.getItem(BACKED_UP(actor)) === "1"; } catch { return false; } };

/**
 * An encrypted copy of the secret that only the auditor's viewing key opens (96 bytes:
 * R = r·P_a as a full point, then secret XOR sha256(r·H)). The committee can return it to the
 * account's owner if this browser's copy is lost. It gives the committee nothing it does not
 * already have: it can read every amount with the viewing key, and spending still needs the
 * wallet's own signature.
 */
export async function recoveryBlob(secret: Hex, auditorPubkey: Hex): Promise<Hex> {
  const { H, mul, ptFromHex, ptHex, randScalar } = await import("./crypto/babyjub");
  const r = randScalar();
  const R = mul(ptFromHex(auditorPubkey.replace(/^0x/, "")), r);
  const K = mul(H, r);
  const keyBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ptHex(K))));
  const s = secret.replace(/^0x/, "").padStart(64, "0");
  let ct = "";
  for (let i = 0; i < 32; i++) ct += (parseInt(s.slice(i * 2, i * 2 + 2), 16) ^ keyBytes[i]).toString(16).padStart(2, "0");
  return `0x${ptHex(R)}${ct}` as Hex;
}

const PBKDF2_ROUNDS = 600_000;
const hexToBytes = (h: string) => Uint8Array.from(h.replace(/^0x/, "").match(/../g)!.map((b) => parseInt(b, 16)));
const bytesToHex = (u8: Uint8Array) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
async function passphraseKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: PBKDF2_ROUNDS }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/**
 * The secret encrypted with a passphrase only the owner knows: 16-byte salt, 12-byte nonce,
 * 48-byte AES-GCM ciphertext (76 bytes). Stored on chain so any device can restore the key
 * from the passphrase alone. Brute force is slowed by 600,000 PBKDF2 rounds; the passphrase
 * itself has to be long.
 */
export async function passphraseBlob(secret: Hex, passphrase: string): Promise<Hex> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await passphraseKey(passphrase, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, key, hexToBytes(secret.replace(/^0x/, "").padStart(64, "0")) as BufferSource));
  return `0x${bytesToHex(salt)}${bytesToHex(nonce)}${bytesToHex(ct)}` as Hex;
}

export async function openPassphraseBlob(blob: string, passphrase: string): Promise<Hex> {
  const b = hexToBytes(blob);
  if (b.length !== 76) throw new Error("unexpected backup format");
  const key = await passphraseKey(passphrase, b.slice(0, 16));
  try {
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(16, 28) as BufferSource }, key, b.slice(28) as BufferSource));
    return `0x${bytesToHex(pt)}` as Hex;
  } catch {
    throw new Error("that passphrase does not open the backup");
  }
}

export const MIN_PASSPHRASE = 14;

// A generated recovery phrase: six words from a 7,776-word list is about 77 bits, far beyond
// what offline guessing against a public backup can reach even at PBKDF2 speeds.
const WORDS = "abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual adapt add addict address adjust admit adult advance advice aerobic affair afford afraid again age agent agree ahead aim air airport aisle alarm album alcohol alert alien all alley allow almost alone alpha already also alter always amateur amazing among amount amused analyst anchor ancient anger angle angry animal ankle announce annual another answer antenna antique anxiety any apart apology appear apple approve april arch arctic area arena argue arm armed armor army around arrange arrest arrive arrow art artefact artist artwork ask aspect assault asset assist assume asthma athlete atom attack attend attitude attract auction audit august aunt author auto autumn average avocado avoid awake aware away awesome awful awkward axis baby bachelor bacon badge bag balance balcony ball bamboo banana banner bar barely bargain barrel base basic basket battle beach bean beauty because become beef before begin behave behind believe below belt bench benefit best betray better between beyond bicycle bid bike bind biology bird birth bitter black blade blame blanket blast bleak bless blind blood blossom blouse blue blur blush board boat body boil bomb bone bonus book boost border boring borrow boss bottom bounce box boy bracket brain brand brass brave bread breeze brick bridge brief bright bring brisk broccoli broken bronze broom brother brown brush bubble buddy budget buffalo build bulb bulk bullet bundle bunker burden burger burst bus business busy butter buyer buzz cabbage cabin cable cactus cage cake call calm camera camp can canal cancel candy cannon canoe canvas canyon capable capital captain car carbon card cargo carpet carry cart case cash casino castle casual cat catalog catch category cattle caught cause caution cave ceiling celery cement census century cereal certain chair chalk champion change chaos chapter charge chase chat cheap check cheese chef cherry chest chicken chief child chimney choice choose chronic chuckle chunk churn cigar cinnamon circle citizen city civil claim clap clarify claw clay clean clerk clever click client cliff climb clinic clip clock clog close cloth cloud clown club clump cluster clutch coach coast coconut code coffee coil coin collect color column combine come comfort comic common company concert conduct confirm congress connect consider control convince cook cool copper copy coral core corn correct cost cotton couch country couple course cousin cover coyote crack cradle craft cram crane crash crater crawl crazy cream credit creek crew cricket crime crisp critic crop cross crouch crowd crucial cruel cruise crumble crunch crush cry crystal cube culture cup cupboard curious current curtain curve cushion custom cute cycle dad damage damp dance danger daring dash daughter dawn day deal debate debris decade december decide decline decorate decrease deer defense define defy degree delay deliver demand demise denial dentist deny depart depend deposit depth deputy derive describe desert design desk despair destroy detail detect develop device devote diagram dial diamond diary dice diesel diet differ digital dignity dilemma dinner dinosaur direct dirt disagree discover disease dish dismiss disorder display distance divert divide divorce dizzy doctor document dog doll dolphin domain donate donkey donor door dose double dove draft dragon drama drastic draw dream dress drift drill drink drip drive drop drum dry duck dumb dune during dust dutch duty dwarf dynamic eager eagle early earn earth easily east easy echo ecology economy edge edit educate effort egg eight either elbow elder electric elegant element elephant elevator elite else embark embody embrace emerge emotion employ empower empty enable enact end endless endorse enemy energy enforce engage engine enhance enjoy enlist enough enrich enroll ensure enter entire entry envelope episode equal equip era erase erode erosion error erupt escape essay essence estate eternal ethics evidence evil evoke evolve exact example excess exchange excite exclude excuse execute exercise exhaust exhibit exile exist exit exotic expand expect expire explain expose express extend extra eye eyebrow fabric face faculty fade faint faith fall false fame family famous fan fancy fantasy farm fashion fat fatal father fatigue fault favorite feature february federal fee feed feel female fence festival fetch fever few fiber fiction field figure file film filter final find fine finger finish fire firm first fiscal fish fit fitness fix flag flame flash flat flavor flee flight flip float flock floor flower fluid flush fly foam focus fog foil fold follow food foot force forest forget fork fortune forum forward fossil foster found fox fragile frame frequent fresh friend fringe frog front frost frown frozen fruit fuel fun funny furnace fury future gadget gain galaxy gallery game gap garage garbage garden garlic garment gas gasp gate gather gauge gaze general genius genre gentle genuine gesture ghost giant gift giggle ginger giraffe girl give glad glance glare glass glide glimpse globe gloom glory glove glow glue goat goddess gold good goose gorilla gospel gossip govern gown grab grace grain grant grape grass gravity great green grid grief grit grocery group grow grunt guard guess guide guilt guitar gun gym habit hair half hammer hamster hand happy harbor hard harsh harvest hat have hawk hazard head health heart heavy hedgehog height hello helmet help hen hero hidden high hill hint hip hire history hobby hockey hold hole holiday hollow home honey hood hope horn horror horse hospital host hotel hour hover hub huge human humble humor hundred hungry hunt hurdle hurry hurt husband hybrid ice icon idea identify idle ignore ill illegal illness image imitate immense immune impact impose improve impulse inch include income increase index indicate indoor industry infant inflict inform inhale inherit initial inject injury inmate inner innocent input inquiry insane insect inside inspire install intact interest into invest invite involve iron island isolate issue item ivory jacket jaguar jar jazz jealous jeans jelly jewel job join joke journey joy judge juice jump jungle junior junk just kangaroo keen keep ketchup key kick kid kidney kind kingdom kiss kit kitchen kite kitten kiwi knee knife knock know lab label labor ladder lady lake lamp language laptop large later latin laugh laundry lava law lawn lawsuit layer lazy leader leaf learn leave lecture left leg legal legend leisure lemon lend length lens leopard lesson letter level liar liberty library license life lift light like limb limit link lion liquid list little live lizard load loan lobster local lock logic lonely long loop lottery loud lounge love loyal lucky luggage lumber lunar lunch luxury lyrics machine mad magic magnet maid mail main major make mammal man manage mandate mango mansion manual maple marble march margin marine market marriage mask mass master match material math matrix matter maximum maze meadow mean measure meat mechanic medal media melody melt member memory mention menu mercy merge merit merry mesh message metal method middle midnight milk million mimic mind minimum minor minute miracle mirror misery miss mistake mix mixed mixture mobile model modify mom moment monitor monkey monster month moon moral more morning mosquito mother motion motor mountain mouse move movie much muffin mule multiply muscle museum mushroom music must mutual myself mystery myth naive name napkin narrow nasty nation nature near neck need negative neglect neither nephew nerve nest net network neutral never news next nice night noble noise nominee noodle normal north nose notable note nothing notice novel now nuclear number nurse nut oak obey object oblige obscure observe obtain obvious occur ocean october odor off offer office often oil okay old olive olympic omit once one onion online only open opera opinion oppose option orange orbit orchard order ordinary organ orient original orphan ostrich other outdoor outer output outside oval oven over own owner oxygen oyster ozone pact paddle page pair palace palm panda panel panic panther paper parade parent park parrot party pass patch path patient patrol pattern pause pave payment peace peanut pear peasant pelican pen penalty pencil people pepper perfect permit person pet phone photo phrase physical piano picnic picture piece pig pigeon pill pilot pink pioneer pipe pistol pitch pizza place planet plastic plate play please pledge pluck plug plunge poem poet point polar pole police pond pony pool popular portion position possible post potato pottery poverty powder power practice praise predict prefer prepare present pretty prevent price pride primary print priority prison private prize problem process produce profit program project promote proof property prosper protect proud provide public pudding pull pulp pulse pumpkin punch pupil puppy purchase purity purpose purse push put puzzle pyramid quality quantum quarter question quick quit quiz quote rabbit raccoon race rack radar radio rail rain raise rally ramp ranch random range rapid rare rate rather raven raw razor ready real reason rebel rebuild recall receive recipe record recycle reduce reflect reform refuse region regret regular reject relax release relief rely remain remember remind remove render renew rent reopen repair repeat replace report require rescue resemble resist resource response result retire retreat return reunion reveal review reward rhythm rib ribbon rice rich ride ridge rifle right rigid ring riot ripple risk ritual rival river road roast robot robust rocket romance roof rookie room rose rotate rough round route royal rubber rude rug rule run runway rural sad saddle sadness safe sail salad salmon salon salt salute same sample sand satisfy satoshi sauce sausage save say scale scan scare scatter scene scheme school science scissors scorpion scout scrap screen script scrub sea search season seat second secret section security seed seek segment select sell seminar senior sense sentence series service session settle setup seven shadow shaft shallow share shed shell sheriff shield shift shine ship shiver shock shoe shoot shop short shoulder shove shrimp shrug shuffle shy sibling sick side siege sight sign silent silk silly silver similar simple since sing siren sister situate six size skate sketch ski skill skin skirt skull slab slam sleep slender slice slide slight slim slogan slot slow slush small smart smile smoke smooth snack snake snap sniff snow soap soccer social sock soda soft solar soldier solid solution solve someone song soon sorry sort soul sound soup source south space spare spatial spawn speak special speed spell spend sphere spice spider spike spin spirit split spoil sponsor spoon sport spot spray spread spring spy square squeeze squirrel stable stadium staff stage stairs stamp stand start state stay steak steel stem step stereo stick still sting stock stomach stone stool story stove strategy street strike strong struggle student stuff stumble style subject submit subway success such sudden suffer sugar suggest suit summer sun sunny sunset super supply supreme sure surface surge surprise surround survey suspect sustain swallow swamp swap swarm swear sweet swift swim swing switch sword symbol symptom syrup system table tackle tag tail talent talk tank tape target task taste tattoo taxi teach team tell ten tenant tennis tent term test text thank that theme then theory there they thing this thought three thrive throw thumb thunder ticket tide tiger tilt timber time tiny tip tired tissue title toast tobacco today toddler toe together toilet token tomato tomorrow tone tongue tonight tool tooth top topic topple torch tornado tortoise toss total tourist toward tower town toy track trade traffic tragic train transfer trap trash travel tray treat tree trend trial tribe trick trigger trim trip trophy trouble truck true truly trumpet trust truth try tube tuition tumble tuna tunnel turkey turn turtle twelve twenty twice twin twist two type typical ugly umbrella unable unaware uncle uncover under undo unfair unfold unhappy uniform unique unit universe unknown unlock until unusual unveil update upgrade uphold upon upper upset urban urge usage use used useful useless usual utility vacant vacuum vague valid valley valve van vanish vapor various vast vault vehicle velvet vendor venture venue verb verify version very vessel veteran viable vibrant vicious victory video view village vintage violin virtual virus visa visit visual vital vivid vocal voice void volcano volume vote voyage wage wagon wait walk wall walnut want warfare warm warrior wash wasp waste water wave way wealth weapon wear weasel weather web wedding weekend weird welcome west wet whale what wheat wheel when where whip whisper wide width wife wild will win window wine wing wink winner winter wire wisdom wise wish witness wolf woman wonder wood wool word work world worry worth wrap wreck wrestle wrist write wrong yard year yellow you young youth zebra zero zone zoo".split(" ");

/** six random words: strong enough that an offline guess against the public backup is hopeless */
export function generatePassphrase(): string {
  const idx = crypto.getRandomValues(new Uint32Array(6));
  return Array.from(idx, (n) => WORDS[n % WORDS.length]).join(" ");
}

/** why a chosen passphrase is too weak to protect a copy anyone can download, or null if it will do */
export function passphraseProblem(p: string): string | null {
  const s = p.trim();
  if (s.length < MIN_PASSPHRASE) return `Use at least ${MIN_PASSPHRASE} characters, or the generated phrase.`;
  if (/^(.)\1+$/.test(s)) return "That is one character repeated.";
  if (/^(0123456789|1234567890|qwertyuiop|asdfghjkl|password|letmein)/i.test(s.replace(/\s/g, ""))) return "That is a common sequence; anyone guessing offline tries it first.";
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(s)).length;
  const words = s.split(/\s+/).filter(Boolean).length;
  if (words < 4 && kinds < 3) return "Use four or more words, or mix letters, numbers and symbols.";
  return null;
}

export async function createKeypair(actor: string, backend: CryptoBackend): Promise<EncryptionKeypair> {
  const kp = await backend.generateKeypair();
  saveKeypair(actor, kp);
  return kp;
}

export async function importSecret(actor: string, backend: CryptoBackend, secretInput: string, expectedPubkey?: Hex): Promise<EncryptionKeypair> {
  const s = secretInput.trim().toLowerCase();
  const secret = (s.startsWith("0x") ? s : `0x${s}`) as Hex;
  if (!/^0x[0-9a-f]{64}$/.test(secret)) throw new Error("a secret is 32 bytes of hex");
  const kp = { secret, pubkey: await backend.pubkeyOf(secret) };
  if (expectedPubkey && kp.pubkey.toLowerCase() !== expectedPubkey.toLowerCase()) throw new Error("that secret does not produce the key registered for this account, so it was not saved");
  saveKeypair(actor, kp);
  return kp;
}

/** Export file body (JSON) the user downloads or copies. */
export function exportBlob(actor: string, kp: EncryptionKeypair): string {
  return JSON.stringify(
    {
      format: "pulse-privacy/enckey/v1",
      account: actor,
      network: `xpr-${NETWORK}`,
      secret: kp.secret,
      pubkey: kp.pubkey,
      warning: "Anyone with this secret can read your confidential balance and history. Losing it means you cannot read or spend it.",
    },
    null,
    2
  );
}
