// Types for the parts of three.js the model viewer uses (Stage 9.4). three ships no types of its own, and the usual
// @types/three is another package, which the rules for this stage don't allow; so this declares just what is used,
// checked against three 0.186.1's source. Add to it when the viewer uses something new.

declare module "three" {
  export const ACESFilmicToneMapping: number;
  export const SRGBColorSpace: string;
  export const PCFSoftShadowMap: number;
  export const PCFShadowMap: number;
  export const RepeatWrapping: number;

  export class Vector2 {
    x: number;
    y: number;
    constructor(x?: number, y?: number);
    set(x: number, y: number): this;
  }
  export class Vector3 {
    x: number;
    y: number;
    z: number;
    constructor(x?: number, y?: number, z?: number);
    set(x: number, y: number, z: number): this;
    setScalar(s: number): this;
    copy(v: Vector3): this;
    clone(): Vector3;
    add(v: Vector3): this;
    sub(v: Vector3): this;
    addScaledVector(v: Vector3, s: number): this;
    multiplyScalar(s: number): this;
    normalize(): this;
    length(): number;
    setLength(l: number): this;
    distanceTo(v: Vector3): number;
    lerpVectors(a: Vector3, b: Vector3, t: number): this;
    applyAxisAngle(axis: Vector3, angle: number): this;
    project(camera: Camera): this;
  }
  export class Euler {
    x: number;
    y: number;
    z: number;
  }
  export class Color {
    constructor(r?: number | string, g?: number, b?: number);
    multiplyScalar(s: number): this;
  }
  export class Box3 {
    min: Vector3;
    max: Vector3;
    constructor(min?: Vector3, max?: Vector3);
    expandByPoint(p: Vector3): this;
    union(b: Box3): this;
    getSize(target: Vector3): Vector3;
    getCenter(target: Vector3): Vector3;
  }

  export class Object3D {
    name: string;
    position: Vector3;
    rotation: Euler;
    scale: Vector3;
    up: Vector3;
    children: Object3D[];
    castShadow: boolean;
    receiveShadow: boolean;
    visible: boolean;
    add(...o: Object3D[]): this;
    traverse(fn: (o: Object3D) => void): void;
    lookAt(v: Vector3): void;
    updateMatrixWorld(force?: boolean): void;
  }
  export class Group extends Object3D {}
  export class Scene extends Object3D {
    environment: Texture | null;
    environmentIntensity: number;
  }
  export class Camera extends Object3D {
    clone(): this;
  }
  export class PerspectiveCamera extends Camera {
    aspect: number;
    constructor(fov?: number, aspect?: number, near?: number, far?: number);
    updateProjectionMatrix(): void;
  }
  export class OrthographicCamera extends Camera {
    left: number;
    right: number;
    top: number;
    bottom: number;
    near: number;
    far: number;
  }

  export class Texture {
    name: string;
    wrapS: number;
    wrapT: number;
    colorSpace: string;
    anisotropy: number;
    repeat: Vector2;
    offset: Vector2;
    dispose(): void;
  }
  export class CanvasTexture extends Texture {
    constructor(canvas: HTMLCanvasElement);
  }

  export class BufferAttribute {
    constructor(array: ArrayLike<number>, itemSize: number);
  }
  export class BufferGeometry {
    setAttribute(name: string, a: BufferAttribute): this;
    addGroup(start: number, count: number, materialIndex?: number): void;
    computeBoundingSphere(): void;
    dispose(): void;
  }
  export class PlaneGeometry extends BufferGeometry {
    constructor(w?: number, h?: number);
  }

  export class Material {
    dispose(): void;
  }
  export type MeshStandardMaterialParameters = {
    color?: Color | string | number;
    map?: Texture | null;
    roughness?: number;
    metalness?: number;
    polygonOffset?: boolean;
    polygonOffsetFactor?: number;
    polygonOffsetUnits?: number;
  };
  export class MeshStandardMaterial extends Material {
    constructor(p?: MeshStandardMaterialParameters);
  }
  export class LineBasicMaterial extends Material {
    constructor(p?: { color?: Color | string | number; transparent?: boolean; opacity?: number });
  }
  export class ShadowMaterial extends Material {
    constructor(p?: { color?: Color | string | number; opacity?: number });
  }

  export class Mesh extends Object3D {
    readonly isMesh: true;
    geometry: BufferGeometry;
    material: Material | Material[];
    constructor(geometry?: BufferGeometry, material?: Material | Material[]);
  }
  export class LineSegments extends Object3D {
    constructor(geometry?: BufferGeometry, material?: Material);
  }

  export class Light extends Object3D {
    intensity: number;
  }
  export class DirectionalLight extends Light {
    target: Object3D;
    shadow: { mapSize: Vector2; camera: Camera; bias: number; normalBias: number; radius: number; map: { dispose(): void } | null };
    constructor(color?: Color | string | number, intensity?: number);
  }
  export class HemisphereLight extends Light {
    constructor(sky?: Color | string | number, ground?: Color | string | number, intensity?: number);
  }

  export class WebGLRenderTarget {
    texture: Texture;
    dispose(): void;
  }
  export class WebGLRenderer {
    domElement: HTMLCanvasElement;
    toneMapping: number;
    toneMappingExposure: number;
    outputColorSpace: string;
    shadowMap: { enabled: boolean; type: number; autoUpdate: boolean; needsUpdate: boolean };
    capabilities: { getMaxAnisotropy(): number };
    constructor(p?: { antialias?: boolean; alpha?: boolean; powerPreference?: string; preserveDrawingBuffer?: boolean });
    setPixelRatio(r: number): void;
    getPixelRatio(): number;
    setSize(w: number, h: number, updateStyle?: boolean): void;
    getSize(target: Vector2): Vector2;
    setClearColor(c: number | string, alpha?: number): void;
    render(scene: Object3D, camera: Camera): void;
    dispose(): void;
    forceContextLoss(): void;
  }
  export class PMREMGenerator {
    constructor(renderer: WebGLRenderer);
    fromScene(scene: Scene, sigma?: number): WebGLRenderTarget;
    dispose(): void;
  }
}

declare module "three/addons/controls/OrbitControls.js" {
  import type { Camera, Vector3 } from "three";
  export class OrbitControls {
    target: Vector3;
    enableDamping: boolean;
    dampingFactor: number;
    rotateSpeed: number;
    screenSpacePanning: boolean;
    minDistance: number;
    maxDistance: number;
    constructor(camera: Camera, dom: HTMLElement);
    addEventListener(type: "change" | "start" | "end", fn: () => void): void;
    update(): boolean;
    dispose(): void;
  }
}

declare module "three/addons/environments/RoomEnvironment.js" {
  import { Scene } from "three";
  export class RoomEnvironment extends Scene {}
}

declare module "three/addons/exporters/GLTFExporter.js" {
  import type { Object3D } from "three";
  export class GLTFExporter {
    parseAsync(input: Object3D, options?: { binary?: boolean }): Promise<ArrayBuffer | object>;
  }
}

declare module "three/addons/exporters/STLExporter.js" {
  import type { Object3D } from "three";
  export class STLExporter {
    parse(input: Object3D, options?: { binary?: boolean }): DataView | string;
  }
}
