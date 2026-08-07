import l10nJson from "./l10n.json" with {type: "json"};
import assetsJson from "./assets.json" with {type: "json"};
import { createHash } from "node:crypto";
import { execFile } from "child_process";
import fs from "fs/promises";
import jsonbig from "json-bigint";
import path from "path";
import process from "process";
import sharp from "sharp";
import { program } from "commander";

program
    .option("-r, --read", null, false)
    .option("-f, --file <filename>", null, "graphs/entry_stage.json")
    .option("-i, --illustrations <directory>", "立绘输出目录", "illustrations");
program.parse();
const opts = program.opts();

const SPECIAL_FIELDS = {};
const mainJson = jsonbig({ storeAsString: true }).parse(await fs.readFile(opts.file, "utf8"));
const assetByKey = new Map(assetsJson.map(asset => [`${asset.type}:${asset.path_id}`, asset]));
const objectCache = new Map();
function pointerId(pointer) {
    return pointer?.m_PathID ?? pointer?.path_id;
}
function findAsset(pathId, type = "Sprite") {
    if (pathId === undefined || pathId === null || String(pathId) === "0") return undefined;
    return assetByKey.get(`${type}:${String(pathId)}`);
}
function getAssetPlainName(pathId, type = "Sprite") {
    const asset = findAsset(pathId, type);
    return asset?.relative_path
        ? path.basename(asset.relative_path, path.extname(asset.relative_path))
        : undefined;
}
async function readExportedObject(pathId, type = "MonoBehaviour") {
    const asset = findAsset(pathId, type);
    if (!asset?.relative_path) return undefined;
    if (!objectCache.has(asset.relative_path)) {
        objectCache.set(
            asset.relative_path,
            jsonbig({ storeAsString: true }).parse(await fs.readFile(asset.relative_path, "utf8"))
        );
    }
    return objectCache.get(asset.relative_path);
}
function spriteName(asset) {
    return asset?.relative_path
        ? path.basename(asset.relative_path, path.extname(asset.relative_path))
        : undefined;
}
async function resolveAvatarReference(ref) {
    if (!ref) return undefined;
    const direct = getAssetPlainName(pointerId(ref), "Sprite");
    if (direct) return direct;
    const avatar = await readExportedObject(pointerId(ref), "MonoBehaviour");
    if (!avatar) return undefined;
    for (const key of ["Sprite", "Normal", "Wink", "Dumbness", "DumbnessWink"]) {
        const resolved = getAssetPlainName(pointerId(avatar[key]), "Sprite");
        if (resolved) return resolved;
    }
    return undefined;
}
async function resolveExplicitAvatar(refData) {
    if (!refData?.Enabled) return undefined;
    return await resolveAvatarReference(refData.Sprite)
        ?? await resolveAvatarReference(refData.QlcAvatar);
}
const CHARACTER_PREFIX = new Map([
    ["QianLucai", "QLC"], ["YanLiaoliao", "YLL"], ["LuoLuoai", "LLA"],
    ["JiangBolao", "JBL"], ["JiYe", "JY"], ["HongZhenli", "HZL"],
    ["LuoMiujia", "LMJ"], ["QianSanyuan", "QSY"], ["QiuLian", "QL"]
]);
const characterById = new Map();
const characterByNameId = new Map();
const characterByPathId = new Map();
const spriteAssets = assetsJson.filter(asset => asset.type === "Sprite" && asset.relative_path);
const spriteByPathId = new Map(spriteAssets.map(asset => [String(asset.path_id), asset]));
const spritesByPrefix = new Map();
const spriteLayoutByPathId = new Map();
const utf16 = text => Buffer.from(text, "utf16le");
function decodeSpriteLayouts(characterObject) {
    const rawBytes = characterObject.serializationData?.SerializedBytes ?? [];
    const references = characterObject.serializationData?.ReferencedUnityObjects ?? [];
    const bytes = Buffer.from(rawBytes.map(value => (Number(value) + 256) % 256));
    const spriteToken = utf16("Sprite");
    const positionToken = utf16("Position");
    const sortingToken = utf16("SortingOrder");
    const layouts = new Map();
    let cursor = 0;
    while ((cursor = bytes.indexOf(spriteToken, cursor)) >= 0) {
        const referenceOffset = cursor + spriteToken.length;
        if (referenceOffset + 4 > bytes.length) break;
        const referenceIndex = bytes.readInt32LE(referenceOffset);
        const positionOffset = bytes.indexOf(positionToken, referenceOffset + 4);
        const sortingOffset = bytes.indexOf(sortingToken, positionOffset + positionToken.length);
        if (positionOffset < 0 || sortingOffset < 18) break;
        const pointer = references[referenceIndex];
        if (pointer) {
            const x = bytes.readFloatLE(sortingOffset - 16);
            const y = bytes.readFloatLE(sortingOffset - 11);
            const orderOffset = sortingOffset + sortingToken.length;
            const sortingOrder = orderOffset + 4 <= bytes.length ? bytes.readInt32LE(orderOffset) : 0;
            if (Number.isFinite(x) && Number.isFinite(y)) {
                layouts.set(String(pointer.m_PathID), { x, y, sortingOrder });
            }
        }
        cursor = referenceOffset + 4;
    }
    return layouts;
}
for (const asset of assetsJson.filter(a => a.type === "MonoBehaviour" && /_character\.bundle$/i.test(a.bundle))) {
    const object = await readExportedObject(asset.path_id, "MonoBehaviour");
    if (object?.Id !== undefined) characterById.set(String(object.Id), object);
    if (object?.NameId !== undefined) characterByNameId.set(String(object.NameId), object);
    characterByPathId.set(String(asset.path_id), object);

    const characterName = [...CHARACTER_PREFIX.keys()].find(name =>
        asset.bundle.toLowerCase() === `${name.toLowerCase()}_character.bundle`
    );
    const prefix = CHARACTER_PREFIX.get(characterName);
    if (!prefix || !object) continue;
    const orderedSprites = (object.serializationData?.ReferencedUnityObjects ?? [])
        .map(pointer => spriteByPathId.get(String(pointer.m_PathID)))
        .filter(Boolean);
    for (const [pathId, layout] of decodeSpriteLayouts(object)) {
        spriteLayoutByPathId.set(pathId, layout);
    }
    spritesByPrefix.set(prefix, orderedSprites);
}
const avatarPrefixByCharacterName = CHARACTER_PREFIX;
const dialogueAvatarAssets = assetsJson.filter(a =>
    a.type === "MonoBehaviour" && /^DA_/i.test(a.name)
);
const avatarByCharacterId = new Map();
for (const asset of dialogueAvatarAssets) {
    const object = await readExportedObject(asset.path_id, "MonoBehaviour");
    if (object?.Character_Id !== undefined) {
        if (!avatarByCharacterId.has(String(object.Character_Id))) avatarByCharacterId.set(String(object.Character_Id), []);
        avatarByCharacterId.get(String(object.Character_Id)).push(object);
    }
}
function avatarCandidates(characterId, type = 1) {
    const all = avatarByCharacterId.get(String(characterId)) ?? [];
    const marker = Number(type) === 1 ? "_A_" : "_H_";
    return all.filter(a => a.m_Name?.includes(marker)).concat(all.filter(a => !a.m_Name?.includes(marker)));
}
async function resolveCharacterAvatar(characterId, type = 1) {
    if (characterId === undefined || characterId === null) return undefined;
    for (const avatar of avatarCandidates(characterId, type)) {
        const sprite = await resolveAvatarReference(avatar.Normal)
            ?? await resolveAvatarReference(avatar.Wink);
        if (sprite) return sprite;
    }
    const character = characterById.get(String(characterId));
    const embedded = await resolveAvatarReference(character?.Avatar)
        ?? await resolveAvatarReference(character?.avatar);
    if (embedded) return embedded;
    const prefix = avatarPrefixByCharacterName.get(character?.m_Name);
    if (!prefix) return undefined;
    const candidates = assetsJson.filter(asset =>
        asset.type === "Sprite" && asset.name.startsWith(`DialogueAvatar_${prefix}`)
    );
    const mode = Number(type) === 1 ? "_A_" : "_H_";
    const preferred = candidates.find(a => a.name.includes(mode) && /_(Usual|Costume)$/.test(a.name))
        ?? candidates.find(a => a.name.includes(mode) && !/Black|Wink|Dumbness/.test(a.name))
        ?? candidates.find(a => /_H_Usual$/.test(a.name))
        ?? candidates.find(a => !/Black|Wink|Dumbness/.test(a.name))
        ?? candidates[0];
    return spriteName(preferred);
}
function familyFromPayload(payload) {
    if (Number(payload.CharacterGroup) === 1) return "H";
    for (const [field, family] of [["Detective", "Det"], ["Army", "Army"], ["Brave", "Brave"], ["AC", "AC"]]) {
        if (Number(payload[`Expression_${field}`] ?? 0) > 0 || Number(payload[`DynamicItem_${field}`] ?? 0) > 0) return family;
    }
    return "A";
}
function valueForLayer(payload, family, layer) {
    const fieldFamily = family === "A" ? "Adult" : family === "Det" ? "Detective" : family;
    const genericField = layer === "DynamicItem" ? "Dynamic_Item" : layer;
    return Number(payload[`${layer}_${fieldFamily}`] ?? payload[genericField] ?? 0);
}
function matchesFamily(name, prefix, family) {
    const normalized = name.replace(/^JiYa_AC_/, "JY_AC_").replace(/^JiYe_AC_/, "JY_AC_");
    return normalized.startsWith(`${prefix}_${family}_`)
        || (family === "A" && normalized.startsWith(`${prefix}_`) && !/^\w+_(?:H|Det|Army|Brave|AC)_/.test(normalized));
}
function layerCandidates(characterSprites, prefix, family, layer) {
    const token = layer === "Expression" ? "Exp" : layer === "DynamicItem" ? "Dynamic" : layer;
    return characterSprites
        .filter(asset => matchesFamily(asset.name, prefix, family))
        .filter(asset => asset.name.includes(`_${token}_`) || asset.name.endsWith(`_${token}`))
        .filter(asset => !asset.name.endsWith("_Talking") && !asset.name.includes("_Wink"));
}
function resolveIllustrationLayers(characterName, payload) {
    const prefix = CHARACTER_PREFIX.get(characterName);
    if (!prefix) throw new Error(`未知角色 ${characterName}`);
    const characterSprites = spritesByPrefix.get(prefix) ?? [];
    const family = familyFromPayload(payload);
    const clothValue = valueForLayer(payload, family, "Cloth");
    const expressionValue = valueForLayer(payload, family, "Expression");
    const dynamicValue = valueForLayer(payload, family, "DynamicItem");
    const bodies = layerCandidates(characterSprites, prefix, family, "Body");
    const body = family === "A"
        ? clothValue > 0
            ? bodies.find(asset => !/_Naked$/i.test(asset.name)) ?? bodies[0]
            : bodies.find(asset => /_Naked$/i.test(asset.name)) ?? bodies[0]
        : bodies[0];
    const indexed = (layer, value) => value > 0
        ? layerCandidates(characterSprites, prefix, family, layer)[value - 1]
        : undefined;
    const dynamics = dynamicValue > 0
        ? layerCandidates(characterSprites, prefix, family, "DynamicItem")
            .filter((_, index) => (dynamicValue & (1 << index)) !== 0)
        : [];
    return [body, indexed("Cloth", clothValue), indexed("Expression", expressionValue), ...dynamics].filter(Boolean);
}
async function renderIllustration(layers, flipX) {
    const pixelsPerUnit = 100;
    const images = await Promise.all(layers.map(async asset => {
        const input = await fs.readFile(asset.relative_path);
        const metadata = await sharp(input).metadata();
        const layout = spriteLayoutByPathId.get(String(asset.path_id)) ?? { x: 0, y: 0, sortingOrder: 0 };
        const width = metadata.width ?? 0;
        const height = metadata.height ?? 0;
        return {
            asset, input, width, height, sortingOrder: layout.sortingOrder,
            worldLeft: layout.x * pixelsPerUnit - width / 2,
            worldTop: -layout.y * pixelsPerUnit - height / 2
        };
    }));
    if (images.length === 0) throw new Error("没有找到可绘制的 Sprite 图层");
    const defaultLayerOrder = asset => {
        if (/_Body(?:_|$)/i.test(asset.name)) return 0;
        if (/_Exp(?:_|$)/i.test(asset.name)) return 1;
        if (/_Cloth(?:_|$)/i.test(asset.name)) return 2;
        if (/_Dynamic(?:_|$)/i.test(asset.name)) return 3;
        return 0;
    };
    images.sort((a, b) => a.sortingOrder - b.sortingOrder || defaultLayerOrder(a.asset) - defaultLayerOrder(b.asset));
    const minLeft = Math.floor(Math.min(...images.map(image => image.worldLeft)));
    const minTop = Math.floor(Math.min(...images.map(image => image.worldTop)));
    const maxRight = Math.ceil(Math.max(...images.map(image => image.worldLeft + image.width)));
    const maxBottom = Math.ceil(Math.max(...images.map(image => image.worldTop + image.height)));
    let rendered = sharp({
        create: {
            width: maxRight - minLeft,
            height: maxBottom - minTop,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 }
        }
    }).composite(images.map(image => ({
        input: image.input,
        left: Math.round(image.worldLeft - minLeft),
        top: Math.round(image.worldTop - minTop)
    })));
    if (flipX) rendered = rendered.flop();
    return rendered.png().toBuffer();
}
const layerFieldPattern = /^(?:Cloth|Expression|DynamicItem)_(?:H|Adult|Detective|Army|Brave|AC)$/;
function mergeCharacterState(previous, payload) {
    const nextGroup = Number(payload.CharacterGroup ?? previous?.CharacterGroup ?? 0);
    const nextSubGroup = Number(payload.SubGroup_Adult ?? previous?.SubGroup_Adult ?? 0);
    const familyChanged = previous && (nextGroup !== Number(previous.CharacterGroup ?? 0)
        || (nextGroup === 0 && nextSubGroup !== Number(previous.SubGroup_Adult ?? 0)));
    const next = familyChanged ? {} : { ...(previous ?? {}) };
    for (const [field, value] of Object.entries(payload)) {
        if ((layerFieldPattern.test(field) || field === "Dynamic_Item") && Number(value) === 0) continue;
        next[field] = value;
    }
    next.CharacterGroup = nextGroup;
    next.SubGroup_Adult = nextSubGroup;
    return next;
}
const illustrationStateByCharacter = new Map();
const emittedIllustrations = new Set();
await fs.mkdir(opts.illustrations, { recursive: true });
await fs.mkdir("sounds", { recursive: true });
await fs.mkdir("cg-parts", { recursive: true });
async function processCharacterAction(action) {
    const characterName = action.type.slice("CharacterAction_".length);
    if (Number(action.payload?.Operation ?? 0) !== 0) {
        illustrationStateByCharacter.delete(characterName);
        return null;
    }
    const payload = mergeCharacterState(illustrationStateByCharacter.get(characterName), action.payload ?? {});
    illustrationStateByCharacter.set(characterName, payload);
    const png = await renderIllustration(resolveIllustrationLayers(characterName, payload), Boolean(payload.FlipX));
    const sha256 = createHash("sha256").update(png).digest("hex");
    if (!emittedIllustrations.has(sha256)) {
        const outputFile = path.join(opts.illustrations, `${sha256}.png`);
        try {
            await fs.access(outputFile);
        } catch {
            await fs.writeFile(outputFile, png);
        }
        emittedIllustrations.add(sha256);
    }
    return sha256;
}
const { Chs: l10n } = l10nJson;
const { actions } = mainJson.screenplays[0];
const avatarBindings = new Map();
const historyAvatars = new Map();
const currentAvatarBySpeaker = new Map();
let selfSpeakerCharacterId = undefined;
const result = [];
function speakerKey(speaker) {
    if (!speaker) return undefined;
    if (speaker.reference_character) return `character:${String(pointerId(speaker.character))}`;
    return `name:${String(speaker.speaker_name_id ?? "")}`;
}
let i = 0;
const length = actions.length;
for (const action of actions) {
    if (!action.active) continue;
    i++;
    process.stdout.write(`${i}/${length}\r`);
    const payload = action.payload ?? {};
    if (action.type === "AvatarBindAction") {
        const nameId = String(payload.NameId ?? "");
        if (Number(payload.Operation) === 0) avatarBindings.set(nameId, payload.CharacterId);
        else if (Number(payload.Operation) === 1) avatarBindings.delete(nameId);
    }
    if (action.type === "HistoryAvatarAction") {
        const characterId = String(payload.CharacterId ?? "");
        if (Number(payload.Operation) === 0) historyAvatars.set(characterId, await resolveAvatarReference(payload.Avatar));
        else if (Number(payload.Operation) === 1) historyAvatars.delete(characterId);
        if (payload.SelfSpeakerCharacterId !== undefined && payload.SelfSpeakerCharacterId !== null && String(payload.SelfSpeakerCharacterId) !== "0") {
            selfSpeakerCharacterId = payload.SelfSpeakerCharacterId;
        }
    }
    const refData = action.dialogue?.AvatarRefData;
    const speakerCharacter = characterByPathId.get(String(pointerId(action.speaker?.character)))
        ?? characterByNameId.get(String(action.speaker?.speaker_name_id ?? ""));
    const speakerNameId = action.speaker?.reference_character
        ? speakerCharacter?.NameId
        : action.speaker?.speaker_name_id;
    const sayer = l10n[speakerNameId]?.replace(/<\/?[^>]+>/g, '')
        ?? speakerCharacter?.Name?.replace(/<\/?[^>]+>/g, '');
    let sprite;
    if (action.type === "DialogueAction") {
        const key = speakerKey(action.speaker);
        sprite = await resolveExplicitAvatar(refData);
        if (sprite && key) currentAvatarBySpeaker.set(key, sprite);
        sprite ??= key ? currentAvatarBySpeaker.get(key) : undefined;
        const nameId = String(action.speaker?.speaker_name_id ?? "");
        const characterObject = speakerCharacter;
        const boundCharacterId = avatarBindings.get(nameId);
        let characterId = boundCharacterId ?? characterObject?.Id;
        if (characterId === undefined && selfSpeakerCharacterId !== undefined && sayer === "我") {
            characterId = selfSpeakerCharacterId;
        }
        sprite ??= historyAvatars.get(String(characterId));
        sprite ??= await resolveCharacterAvatar(characterId, refData?.Type);
        if (sprite && key) currentAvatarBySpeaker.set(key, sprite);
    }
    const isCharacterAction = action.type.startsWith("CharacterAction_");
    const character = isCharacterAction
        ? action.type.slice("CharacterAction_".length)
        : undefined;
    const illustration = isCharacterAction
        ? await processCharacterAction(action)
        : undefined;
    const operation = isCharacterAction
        ? Number(action.payload?.Operation ?? 0)
        : undefined;
    const centerDisplay = Boolean(action.dialogue?.DisplayMode);
    let position;
    let show;
    let layer;
    let spriteForAction;
    if (action.type === "SpriteAction") {
        const px = action.payload?.Position?.x;
        const py = action.payload?.Position?.y;
        if (px !== undefined && py !== undefined) {
            const pixelsPerUnit = 100;
            position = [px * pixelsPerUnit, py * pixelsPerUnit];
        }
        show = !Number(action.payload?.Operation ?? 0);
        layer = action.payload?.OrderInLayer;
        spriteForAction = getAssetPlainName(pointerId(action.payload?.Sprite));
        const spriteAsset = findAsset(pointerId(action.payload?.Sprite), "Sprite");
        if (spriteAsset?.relative_path) {
            const destFile = path.join("cg-parts", path.basename(spriteAsset.relative_path));
            try {
                await fs.access(destFile);
            } catch {
                await fs.copyFile(spriteAsset.relative_path, destFile);
            }
        }
    }
    let sound;
    let track;
    let stop;
    if (action.type === "SoundAction") {
        track = action.payload?.SoundInOptions?.MmSoundManagerTrack;
        stop = action.payload?.Mode === 3;
        const audioClipPathId = pointerId(action.payload?.AudioClip);
        const audioAsset = findAsset(audioClipPathId, "AudioClip");
        if (audioAsset?.relative_path) {
            const outputFile = path.join("sounds", `${audioClipPathId}.mp3`);
            (async () => {
                try {
                    await fs.access(outputFile);
                } catch {
                    execFile("ffmpeg", ["-i", audioAsset.relative_path, "-y", outputFile], (err) => {
                        if (err) console.error(`ffmpeg error: ${err.message}`);
                    });
                }
            })()
            sound = String(audioClipPathId);
        }
    }
    const output = {
        type: isCharacterAction ? "CharacterAction" : action.type,
        text: l10n[action.language_id]?.replace(/<\/?[^>]+>/g, ''),
        sayer,
        order: action.order,
        background: getAssetPlainName(pointerId(action.payload?.BackgroundSprite)),
        pause: action.payload?.PauseDuration,
        center: centerDisplay,
        character,
        operation,
        illustration,
        sound,
        track,
        stop,
        loop: action.payload?.SoundInOptions?.Loop,
        volume: action.payload?.SoundInOptions?.Volume,
        position,
        show,
        layer,
        sprite: spriteForAction,
        ...(SPECIAL_FIELDS[action.path_id] ?? {})
    };
    if (action.type === "DialogueAction") {
        const hasSpeaker = Boolean(sayer || action.speaker?.reference_character);
        if (hasSpeaker) output.sprite = sprite ?? null;
    }
    result.push(output);
}
console.log("节点转换完成");

await fs.writeFile("output.json", JSON.stringify(result, null, 4), "utf8");
await fs.writeFile("tree.jsonl", result.filter(e => [
    "DialogueAction",
    "BackgroundAction",
    "PauseAction",
    "SoundAction",
    "StorylineFlagAction",
    "CinemachineImpulseAction",
    "CharacterAction",
    "GalleryFlagAction",
    "SpriteAction"
].includes(e.type)).map(e => JSON.stringify(e).replaceAll(",", "<UNCENSORED>")).join("\n"), "utf8");
if (opts.read) {
    console.log(
        result.map(e => {
            if (e.type === "DialogueAction") {
                return e.sayer ? `${e.sayer}：${e.text.replaceAll("\n", "\n  ")}` : `\n${e.text}\n`;
            } else {
                return null;
            }
        }).filter(Boolean).join("\n")
    );
}
