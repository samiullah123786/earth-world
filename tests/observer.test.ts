import { describe, expect, it } from 'vitest';
import { RouteBuffer, boundedHeadTurn, visualIdentityKey } from '../src/world3d/observer';
import { lookFromAvatar } from '../src/world3d/citizenKit';
import * as THREE from 'three';
import { CitizenBatch, harvest, type Pose } from '../src/world3d/rig';
import { avatarSpecForVariant } from '../shared/avatar-identity';

describe('shared world observation', () => {
  it('replays a short completed route from server history without inventing a wall-crossing shortcut', () => {
    const buffer = new RouteBuffer();
    const row = { agentId: 'a', tx: 1, ty: 1, recentRoutes: [[{x:0,y:0,at:1000},{x:0,y:1,at:1500},{x:1,y:1,at:2000}]] };
    buffer.ingest([row],3000);
    expect(buffer.position(row,1250)).toEqual({x:0,z:.5,moving:true});
    expect(buffer.position(row,1750)).toEqual({x:.5,z:1,moving:true});
    expect(buffer.position(row,3500)).toEqual({x:1,z:1,moving:false});
  });
  it('preserves received routes after the active route disappears and honors later corrections', () => {
    const buffer = new RouteBuffer();
    buffer.ingest([{agentId:'a',tx:2,ty:0,route:[{x:0,y:0,at:1000},{x:2,y:0,at:2000}]}],1100);
    const row = {agentId:'a',tx:3,ty:0}; buffer.ingest([row],2500);
    expect(buffer.position(row,1500).x).toBe(1);
    expect(buffer.position(row,2600).x).toBe(3);
    buffer.ingest([],2700);
    expect(buffer.position(row,1500).x).toBe(3);
  });
  it('rebuilds appearance for canonical wardrobe, tool, office and evidence changes', () => {
    const citizen = {name:'Ada',avatarSpec:avatarSpecForVariant('female','engineering',1,'owner-styled'),carriedTool:'axe',experienceTier:'emerging'};
    const key = visualIdentityKey(citizen,1);
    for (const update of [{carriedTool:'pickaxe'},{serviceRole:'mayor'},{experienceTier:'seasoned'},{avatarSpec:avatarSpecForVariant('female','engineering',2,'owner-styled')}]) {
      expect(visualIdentityKey({...citizen,...update},1)).not.toBe(key);
    }
    expect(lookFromAvatar('a',0,citizen.avatarSpec).canonicalHair).toBe(citizen.avatarSpec.hairStyle);
    expect(lookFromAvatar('a',0,citizen.avatarSpec).hair).toBe(lookFromAvatar('different',0,citizen.avatarSpec).hair);
  });
  it('bounds neck movement and handles heading wrap', () => {
    expect(boundedHeadTurn(Math.PI,0)).toBe(.65);
    expect(boundedHeadTurn(-Math.PI,0)).toBe(-.65);
    expect(boundedHeadTurn(-Math.PI+.1,Math.PI-.1)).toBeCloseTo(.2);
  });
  it('rotates a harvested head about its neck without rotating the torso', () => {
    const root = new THREE.Group(); const batch = new CitizenBatch(root,new THREE.BoxGeometry(1,1,1));
    const head = new THREE.Group(); const mesh = new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshStandardMaterial());
    mesh.position.set(0,1.7,0); head.add(mesh);
    const torso = new THREE.Group(); const chest = new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshStandardMaterial());
    chest.position.set(0,1,0); torso.add(chest);
    const parts = harvest(torso,'body',[]); harvest(head,'head',parts);
    const pose: Pose = {x:0,y:0,z:0,heading:0,leftArm:0,rightArm:0,leftLeg:0,rightLeg:0,lean:0,scale:1,headYaw:10};
    batch.render([{rig:{agentId:'a',parts,scale:1},pose}]);
    const instances = root.children[0] as THREE.InstancedMesh;
    const bodyMatrix = new THREE.Matrix4(), headMatrix = new THREE.Matrix4();
    instances.getMatrixAt(0,bodyMatrix); instances.getMatrixAt(1,headMatrix);
    const bodyRotation = new THREE.Quaternion(), headRotation = new THREE.Quaternion();
    bodyMatrix.decompose(new THREE.Vector3(),bodyRotation,new THREE.Vector3());
    headMatrix.decompose(new THREE.Vector3(),headRotation,new THREE.Vector3());
    expect(new THREE.Euler().setFromQuaternion(bodyRotation).y).toBeCloseTo(0);
    expect(new THREE.Euler().setFromQuaternion(headRotation).y).toBeCloseTo(.65);
  });

});
