// Light oblique projection shared by the furniture and the layout: depth recedes up and slightly right.
export const KX = 0.2, KY = 0.46;
export type Point = readonly [number, number];
/** World (x right, y up, z into the room) to a screen offset from the front floor line. */
export const P = (x: number, y: number, z: number): [number, number] => [x + z * KX, -y - z * KY];
export const at = (origin: Point, x: number, y: number, z: number): [number, number] => { const [sx, sy] = P(x, y, z); return [origin[0] + sx, origin[1] + sy]; };

export const DESK = { w: 184, h: 52, d: 40, slab: 5 } as const;
/** The capybara sits just behind the desk; the front panel hides everything below its paws. */
export const SEAT = { x: 62, y: 24, z: DESK.d + 4 } as const;
/** A sub-agent's side desk: narrower, lower and set a little apart from its parent's desk. */
export const SUB = { w: 128, seatX: 48, scale: 0.8, h: 40, gap: 10 } as const;
