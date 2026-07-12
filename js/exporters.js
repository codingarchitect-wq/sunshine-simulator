// Geometry export: Wavefront OBJ (+MTL) and COLLADA DAE, both Y-up, meters.
// DAE imports into every desktop SketchUp version (File → Import → COLLADA);
// OBJ covers SketchUp Pro, Blender, FreeCAD, etc. All transforms are baked to
// world space so files import exactly as arranged in the scene.

import * as THREE from 'three';

// Collect world-space triangle soup from the object groups.
// Returns [{ name, color: '#rrggbb', positions: Float64Array-ish [x,y,z,...] }]
export function collectExportMeshes(groups) {
  const out = [];
  for (const group of groups) {
    group.updateMatrixWorld(true);
    group.traverse((node) => {
      if (!node.isMesh) return;
      const geo = node.geometry;
      const posAttr = geo.getAttribute('position');
      if (!posAttr) return;
      const positions = [];
      const v = new THREE.Vector3();
      const pushVert = (idx) => {
        v.fromBufferAttribute(posAttr, idx).applyMatrix4(node.matrixWorld);
        positions.push(v.x, v.y, v.z);
      };
      if (geo.index) {
        for (let i = 0; i < geo.index.count; i++) pushVert(geo.index.getX(i));
      } else {
        for (let i = 0; i < posAttr.count; i++) pushVert(i);
      }
      out.push({
        name: sanitize(`${group.name}_${node.name || 'mesh'}`),
        color: '#' + node.material.color.getHexString(),
        positions,
      });
    });
  }
  return out;
}

function sanitize(s) {
  return s.replace(/[^\w-]+/g, '_');
}

// ---------- OBJ + MTL ----------
export function exportOBJ(meshes, title = 'sunshine-simulator scene') {
  const matNames = new Map(); // color -> material name
  let mtl = `# ${title} — materials\n`;
  for (const m of meshes) {
    if (!matNames.has(m.color)) {
      const name = 'mat_' + m.color.slice(1);
      matNames.set(m.color, name);
      const c = new THREE.Color(m.color);
      mtl += `newmtl ${name}\nKd ${c.r.toFixed(4)} ${c.g.toFixed(4)} ${c.b.toFixed(4)}\nKa 0 0 0\nKs 0 0 0\nd 1\nillum 1\n\n`;
    }
  }
  let obj = `# ${title}\n# units: meters, Y-up\nmtllib scene.mtl\n`;
  let vOffset = 1;
  for (const m of meshes) {
    obj += `o ${m.name}\nusemtl ${matNames.get(m.color)}\n`;
    const p = m.positions;
    const nVerts = p.length / 3;
    for (let i = 0; i < p.length; i += 3)
      obj += `v ${p[i].toFixed(4)} ${p[i + 1].toFixed(4)} ${p[i + 2].toFixed(4)}\n`;
    for (let i = 0; i < nVerts; i += 3)
      obj += `f ${vOffset + i} ${vOffset + i + 1} ${vOffset + i + 2}\n`;
    vOffset += nVerts;
  }
  return { obj, mtl };
}

// ---------- COLLADA (.dae) ----------
export function exportDAE(meshes, title = 'sunshine-simulator scene') {
  const now = new Date().toISOString();
  let effects = '', materials = '', geometries = '', nodes = '';
  const matIds = new Map();

  for (const m of meshes) {
    if (!matIds.has(m.color)) {
      const id = 'mat' + matIds.size;
      matIds.set(m.color, id);
      const c = new THREE.Color(m.color);
      effects += `
    <effect id="${id}-fx"><profile_COMMON><technique sid="common"><lambert>
      <diffuse><color>${c.r.toFixed(4)} ${c.g.toFixed(4)} ${c.b.toFixed(4)} 1</color></diffuse>
    </lambert></technique></profile_COMMON></effect>`;
      materials += `\n    <material id="${id}" name="${id}"><instance_effect url="#${id}-fx"/></material>`;
    }
  }

  meshes.forEach((m, gi) => {
    const gid = 'geom' + gi;
    const mid = matIds.get(m.color);
    const nVerts = m.positions.length / 3;
    const nTris = nVerts / 3;
    const floats = m.positions.map((x) => +x.toFixed(4)).join(' ');
    const indices = Array.from({ length: nVerts }, (_, i) => i).join(' ');
    geometries += `
    <geometry id="${gid}" name="${m.name}"><mesh>
      <source id="${gid}-pos">
        <float_array id="${gid}-pos-array" count="${m.positions.length}">${floats}</float_array>
        <technique_common><accessor source="#${gid}-pos-array" count="${nVerts}" stride="3">
          <param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/>
        </accessor></technique_common>
      </source>
      <vertices id="${gid}-vtx"><input semantic="POSITION" source="#${gid}-pos"/></vertices>
      <triangles material="${mid}" count="${nTris}">
        <input semantic="VERTEX" source="#${gid}-vtx" offset="0"/>
        <p>${indices}</p>
      </triangles>
    </mesh></geometry>`;
    nodes += `
      <node id="node${gi}" name="${m.name}">
        <instance_geometry url="#${gid}">
          <bind_material><technique_common>
            <instance_material symbol="${mid}" target="#${mid}"/>
          </technique_common></bind_material>
        </instance_geometry>
      </node>`;
  });

  return `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset>
    <contributor><authoring_tool>Sunshine Simulator</authoring_tool></contributor>
    <created>${now}</created><modified>${now}</modified>
    <unit name="meter" meter="1"/><up_axis>Y_UP</up_axis>
  </asset>
  <library_effects>${effects}
  </library_effects>
  <library_materials>${materials}
  </library_materials>
  <library_geometries>${geometries}
  </library_geometries>
  <library_visual_scenes>
    <visual_scene id="Scene" name="${title}">${nodes}
    </visual_scene>
  </library_visual_scenes>
  <scene><instance_visual_scene url="#Scene"/></scene>
</COLLADA>`;
}

// ---------- download helper ----------
export function download(filename, content, type = 'text/plain') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
