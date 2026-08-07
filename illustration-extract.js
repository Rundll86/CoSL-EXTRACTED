import assetsJson from "./assets.json" with { type: "json" };
import { createHash } from "node:crypto";
import fs from "fs/promises";
import path from "path";
import process from "process";
import jsonbig from "json-bigint";
import sharp from "sharp";
import { program } from "commander";

program
    .description("从剧本图的 CharacterAction 节点还原并导出角色立绘")
    .option("-f, --file <filename>", "剧本图 JSON 文件", "graphs/entry_stage.json")
    .option("-o, --output <directory>", "输出目录", "illustrations")
    .option("--inactive", "同时导出 Active=0 的节点", false)
    .option("--overwrite", "覆盖已经存在的 PNG", false);
program.parse();
const options = program.opts();

const CHARACTER_PREFIX = new Map([
    ["JiangBolao", "JBL"],
    ["JiYe", "JY"],
    ["LuoLuoai", "LLA"],
    ["YanLiaoliao", "YLL"],
    ["QianLucai", "QLC"],
    ["QianSanyuan", "QSY"],
    ["QiuLian", "QL"],
    ["LuoMiujia", "LMJ"],
    ["HongZhenli", "HZL"]
]);

const json = jsonbig({ storeAsString: true });
const graph = json.parse(await fs.readFile(options.file, "utf8"));
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
            // Odin 在 Vector2 的两个 float 前各写入一个 0x20 基元标记。
            const x = bytes.readFloatLE(sortingOffset - 16);
            const y = bytes.readFloatLE(sortingOffset - 11);
            const orderOffset = sortingOffset + sortingToken.length;
            const sortingOrder = orderOffset + 4 <= bytes.length
                ? bytes.readInt32LE(orderOffset)
                : 0;
            if (Number.isFinite(x) && Number.isFinite(y)) {
                layouts.set(String(pointer.m_PathID), { x, y, sortingOrder });
            }
        }
        cursor = referenceOffset + 4;
    }
    return layouts;
}

for (const [characterName, prefix] of CHARACTER_PREFIX) {
    const characterAsset = assetsJson.find(asset =>
        asset.type === "MonoBehaviour"
        && asset.bundle.toLowerCase() === `${characterName.toLowerCase()}_character.bundle`
    );
    if (!characterAsset?.relative_path) continue;
    const characterObject = json.parse(await fs.readFile(characterAsset.relative_path, "utf8"));
    const orderedSprites = (characterObject.serializationData?.ReferencedUnityObjects ?? [])
        .map(pointer => spriteByPathId.get(String(pointer.m_PathID)))
        .filter(Boolean);
    for (const [pathId, layout] of decodeSpriteLayouts(characterObject)) {
        spriteLayoutByPathId.set(pathId, layout);
    }
    spritesByPrefix.set(prefix, orderedSprites);
}

function familyFromPayload(payload) {
    if (Number(payload.CharacterGroup) === 1) return "H";
    const candidates = [
        ["Detective", "Det"],
        ["Army", "Army"],
        ["Brave", "Brave"],
        ["AC", "AC"]
    ];
    for (const [field, family] of candidates) {
        if (Number(payload[`Expression_${field}`] ?? 0) > 0 || Number(payload[`DynamicItem_${field}`] ?? 0) > 0) {
            return family;
        }
    }
    return "A";
}

function valueForLayer(payload, family, layer) {
    const fieldFamily = family === "A" ? "Adult"
        : family === "Det" ? "Detective"
            : family;
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

function selectBody(characterSprites, prefix, family, payload) {
    const bodies = layerCandidates(characterSprites, prefix, family, "Body");
    if (bodies.length === 0) return undefined;
    if (family === "A") {
        const cloth = valueForLayer(payload, family, "Cloth");
        if (cloth > 0) return bodies.find(asset => !/_Naked$/i.test(asset.name)) ?? bodies[0];
        return bodies.find(asset => /_Naked$/i.test(asset.name)) ?? bodies[0];
    }
    return bodies[0];
}

function selectIndexedLayer(characterSprites, prefix, family, layer, value) {
    if (value <= 0) return undefined;
    const candidates = layerCandidates(characterSprites, prefix, family, layer);
    return candidates[value - 1];
}

function selectDynamicLayers(characterSprites, prefix, family, value) {
    if (value <= 0) return [];
    const candidates = layerCandidates(characterSprites, prefix, family, "DynamicItem");
    // DynamicItem 是 [Flags] 位掩码，而不是普通的从 1 开始的枚举。
    // 例如值 5 表示同时启用第 1、3 个挂件，值 7 表示启用前三个。
    return candidates.filter((_, index) => (value & (1 << index)) !== 0);
}

function resolveLayers(action) {
    const characterName = action.type.slice("CharacterAction_".length);
    const prefix = CHARACTER_PREFIX.get(characterName);
    if (!prefix) throw new Error(`未知角色 ${characterName}`);
    const characterSprites = spritesByPrefix.get(prefix) ?? [];
    const payload = action.payload ?? {};
    const family = familyFromPayload(payload);
    const layers = [selectBody(characterSprites, prefix, family, payload)];

    const clothValue = valueForLayer(payload, family, "Cloth");
    const expressionValue = valueForLayer(payload, family, "Expression");
    const dynamicValue = valueForLayer(payload, family, "DynamicItem");
    layers.push(selectIndexedLayer(characterSprites, prefix, family, "Cloth", clothValue));
    layers.push(selectIndexedLayer(characterSprites, prefix, family, "Expression", expressionValue));
    layers.push(...selectDynamicLayers(characterSprites, prefix, family, dynamicValue));

    return { characterName, family, layers: layers.filter(Boolean) };
}

async function renderLayers(layers, flipX) {
    const pixelsPerUnit = 100;
    const images = await Promise.all(layers.map(async asset => {
        const input = await fs.readFile(asset.relative_path);
        const metadata = await sharp(input).metadata();
        const layout = spriteLayoutByPathId.get(String(asset.path_id)) ?? {
            x: 0,
            y: 0,
            sortingOrder: 0
        };
        const width = metadata.width ?? 0;
        const height = metadata.height ?? 0;
        return {
            asset,
            input,
            width,
            height,
            sortingOrder: layout.sortingOrder,
            // Unity SpriteRenderer 以 Sprite 中心为原点，Y 轴方向与图片坐标相反。
            worldLeft: layout.x * pixelsPerUnit - width / 2,
            worldTop: -layout.y * pixelsPerUnit - height / 2
        };
    }));
    if (images.length === 0) throw new Error("没有找到可绘制的 Sprite 图层");

    const defaultLayerOrder = asset => {
        const name = asset.name;
        if (/_Body(?:_|$)/i.test(name)) return 0;
        if (/_Exp(?:_|$)/i.test(name)) return 1;
        if (/_Cloth(?:_|$)/i.test(name)) return 2;
        if (/_Dynamic(?:_|$)/i.test(name)) return 3;
        return 0;
    };
    images.sort((a, b) =>
        a.sortingOrder - b.sortingOrder
        || defaultLayerOrder(a.asset) - defaultLayerOrder(b.asset)
    );
    const minLeft = Math.floor(Math.min(...images.map(image => image.worldLeft)));
    const minTop = Math.floor(Math.min(...images.map(image => image.worldTop)));
    const maxRight = Math.ceil(Math.max(...images.map(image => image.worldLeft + image.width)));
    const maxBottom = Math.ceil(Math.max(...images.map(image => image.worldTop + image.height)));
    const width = maxRight - minLeft;
    const height = maxBottom - minTop;
    let rendered = sharp({
        create: {
            width,
            height,
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

const screenplays = Array.isArray(graph.screenplays) ? graph.screenplays : [];
const layerFieldPattern = /^(?:Cloth|Expression|DynamicItem)_(?:H|Adult|Detective|Army|Brave|AC)$/;

function mergeCharacterState(previous, payload) {
    const nextGroup = Number(payload.CharacterGroup ?? previous?.CharacterGroup ?? 0);
    const nextSubGroup = Number(payload.SubGroup_Adult ?? previous?.SubGroup_Adult ?? 0);
    const familyChanged = previous
        && (nextGroup !== Number(previous.CharacterGroup ?? 0)
            || (nextGroup === 0 && nextSubGroup !== Number(previous.SubGroup_Adult ?? 0)));
    const next = familyChanged ? {} : { ...(previous ?? {}) };

    for (const [field, value] of Object.entries(payload)) {
        // 剧情中的后续 CharacterAction 通常只修改一个图层；其余图层写 0
        // 表示“不修改”，不能把已经显示的衣服、表情或挂件清掉。
        if ((layerFieldPattern.test(field) || field === "Dynamic_Item") && Number(value) === 0) continue;
        next[field] = value;
    }
    next.CharacterGroup = nextGroup;
    next.SubGroup_Adult = nextSubGroup;
    return next;
}

const characterActions = [];
for (const screenplay of screenplays) {
    const stateByCharacter = new Map();
    for (const action of Array.isArray(screenplay.actions) ? screenplay.actions : []) {
        if (typeof action.type !== "string" || !action.type.startsWith("CharacterAction_")) continue;
        const enabled = action.active !== false && Number(action.payload?.Active ?? 1) !== 0;
        if (!options.inactive && !enabled) continue;
        const characterName = action.type.slice("CharacterAction_".length);
        if (Number(action.payload?.Operation ?? 0) !== 0) {
            stateByCharacter.delete(characterName);
            continue;
        }
        const effectivePayload = mergeCharacterState(stateByCharacter.get(characterName), action.payload ?? {});
        stateByCharacter.set(characterName, effectivePayload);
        characterActions.push({ ...action, payload: effectivePayload });
    }
}

await fs.mkdir(options.output, { recursive: true });
const emittedHashes = new Set();
let written = 0;
let duplicated = 0;
let existing = 0;
let failed = 0;
for (const action of characterActions) {
    try {
        const resolved = resolveLayers(action);
        const png = await renderLayers(resolved.layers, Boolean(action.payload?.FlipX));
        const sha256 = createHash("sha256").update(png).digest("hex");
        const outputFile = path.join(options.output, `${sha256}.png`);

        if (emittedHashes.has(sha256)) {
            duplicated++;
            console.log(`[重复] ${action.path_id} -> ${sha256}.png`);
            continue;
        }
        if (!options.overwrite) {
            try {
                await fs.access(outputFile);
                emittedHashes.add(sha256);
                existing++;
                console.log(`[已有] ${action.path_id} -> ${sha256}.png`);
                continue;
            } catch {
                // 文件不存在，写入最终 PNG Buffer。
            }
        }

        await fs.writeFile(outputFile, png);
        emittedHashes.add(sha256);
        written++;
        console.log(`[完成] ${action.path_id} -> ${sha256}.png: ${resolved.characterName}/${resolved.family} <- ${resolved.layers.map(x => x.name).join(" + ")}`);
    } catch (error) {
        failed++;
        console.error(`[失败] ${action.path_id}: ${error.message}`);
    }
}

console.log(`处理结束：节点 ${characterActions.length}，唯一图片 ${emittedHashes.size}，写入 ${written}，重复 ${duplicated}，已有 ${existing}，失败 ${failed}。`);
if (failed > 0) process.exitCode = 1;
