import RBush, { BBox } from "rbush";
import {
  Polygon as SATPolygon,
  testCircleCircle,
  testCirclePolygon,
  testPolygonCircle,
  testPolygonPolygon,
} from "sat";

import { BaseSystem } from "./base-system";
import { Line } from "./bodies/line";
import {
  Body,
  CollisionState,
  RaycastResult,
  Response,
  SATVector,
  Types,
  Vector,
} from "./model";
import {
  distance,
  ensureConvexPolygons,
  intersectLineCircle,
  intersectLinePolygon,
  checkAInB,
} from "./utils";

/**
 * collision system
 */
export class System extends BaseSystem {
  response: Response = new Response();

  /**
   * remove body aabb from collision tree
   */
  remove(body: Body, equals?: (a: Body, b: Body) => boolean): RBush<Body> {
    body.system = undefined;

    return super.remove(body, equals);
  }

  /**
   * update body aabb and in tree
   */
  insert(body: Body): RBush<Body> {
    const bounds = body.getAABBAsBBox();
    const update =
      bounds.minX < body.minX ||
      bounds.minY < body.minY ||
      bounds.maxX > body.maxX ||
      bounds.maxY > body.maxY;

    if (body.system && !update) {
      return this;
    }

    // old bounding box *needs* to be removed
    if (body.system) {
      this.remove(body);
    }

    // only then we update min, max
    body.minX = bounds.minX - body.padding;
    body.minY = bounds.minY - body.padding;
    body.maxX = bounds.maxX + body.padding;
    body.maxY = bounds.maxY + body.padding;
    body.system = this;

    // reinsert bounding box to collision tree
    return super.insert(body);
  }

  /**
   * @deprecated please use insert
   */
  updateBody(body: Body): void {
    this.insert(body);
  }

  /**
   * update all bodies aabb
   */
  update(): void {
    this.all().forEach((body: Body) => {
      // no need to every cycle update static body aabb
      if (!body.isStatic) {
        this.insert(body);
      }
    });
  }

  /**
   * separate (move away) colliders
   */
  separate(): void {
    this.checkAll((response: Response) => {
      // static bodies and triggers do not move back / separate
      if (response.a.isTrigger) {
        return;
      }

      response.a.x -= response.overlapV.x;
      response.a.y -= response.overlapV.y;

      this.insert(response.a);
    });
  }

  /**
   * check one collider collisions with callback
   */
  checkOne(body: Body, callback: (response: Response) => void): void {
    // no need to check static body collision
    if (body.isStatic) {
      return;
    }

    this.getPotentials(body).forEach((candidate: Body) => {
      if (this.checkCollision(body, candidate)) {
        callback(this.response);
      }
    });
  }

  /**
   * check all colliders collisions with callback
   */
  checkAll(callback: (response: Response) => void): void {
    this.all().forEach((body: Body) => {
      this.checkOne(body, callback);
    });
  }

  /**
   * get object potential colliders
   */
  getPotentials(body: Body): Body[] {
    // filter here is required as collides with self
    return this.search(body).filter((candidate) => candidate !== body);
  }

  /**
   * check do 2 objects collide
   */
  checkCollision(body: Body, candidate: Body): boolean {
    this.response.clear();

    let result = false;

    const state: CollisionState = {
      collides: false,
    };

    if (body.type === Types.Circle) {
      if (candidate.type === Types.Circle) {
        result = testCircleCircle(body, candidate, this.response);
      } else {
        result = ensureConvexPolygons(candidate).reduce(
          (collidedAtLeastOnce: boolean, convexCandidate: SATPolygon) => {
            state.collides = testCirclePolygon(
              body,
              convexCandidate,
              this.response
            );

            return this.collided(state) || collidedAtLeastOnce;
          },
          false
        );
      }
    } else if (candidate.type === Types.Circle) {
      result = ensureConvexPolygons(body).reduce(
        (collidedAtLeastOnce: boolean, convexBody: SATPolygon) => {
          state.collides = testPolygonCircle(
            convexBody,
            candidate,
            this.response
          );

          return this.collided(state) || collidedAtLeastOnce;
        },
        false
      );
    } else if (!body.isConvex || !candidate.isConvex) {
      const convexBodies = ensureConvexPolygons(body);
      const convexCandidates = ensureConvexPolygons(candidate);

      result = convexBodies.reduce(
        (reduceResult: boolean, convexBody: SATPolygon) =>
          convexCandidates.reduce(
            (collidedAtLeastOnce: boolean, convexCandidate: SATPolygon) => {
              state.collides = testPolygonPolygon(
                convexBody,
                convexCandidate,
                this.response
              );

              return this.collided(state) || collidedAtLeastOnce;
            },
            false
          ) || reduceResult,
        false
      );
    } else {
      result = testPolygonPolygon(body, candidate, this.response);
    }

    // collisionVector is set if body or candidate was concave during this.collided()
    if (state.collisionVector) {
      this.response.overlapV = state.collisionVector;
      this.response.overlapN = this.response.overlapV.clone().normalize();
      this.response.overlap = this.response.overlapV.len();
    }

    // set proper response object bodies
    if (!body.isConvex || !candidate.isConvex) {
      this.response.a = body;
      this.response.b = candidate;
    }

    if (!body.isConvex && !candidate.isConvex) {
      this.response.aInB = checkAInB(body, candidate);
      this.response.bInA = checkAInB(candidate, body);
    } else if (!body.isConvex) {
      this.response.aInB = checkAInB(body, candidate);
      this.response.bInA = !!state.bInA;
    } else if (!candidate.isConvex) {
      this.response.aInB = !!state.aInB;
      this.response.bInA = checkAInB(candidate, body);
    }

    return result;
  }

  /**
   * raycast to get collider of ray from start to end
   */
  raycast(
    start: Vector,
    end: Vector,
    allowCollider: (testCollider: Body) => boolean = () => true
  ): RaycastResult {
    let minDistance = Infinity;
    let result: RaycastResult = null;

    const ray: Line = this.createLine(start, end);
    const colliders: Body[] = this.getPotentials(ray).filter(
      (potential: Body) =>
        allowCollider(potential) && this.checkCollision(ray, potential)
    );

    this.remove(ray);

    colliders.forEach((collider: Body) => {
      const points: Vector[] =
        collider.type === Types.Circle
          ? intersectLineCircle(ray, collider)
          : intersectLinePolygon(ray, collider);

      points.forEach((point: Vector) => {
        const pointDistance: number = distance(start, point);

        if (pointDistance < minDistance) {
          minDistance = pointDistance;
          result = { point, collider };
        }
      });
    });

    return result;
  }

  private collided(state: CollisionState): boolean {
    if (state.collides) {
      // lazy create vector
      if (typeof state.collisionVector === "undefined") {
        state.collisionVector = new SATVector();
      }

      // sum all collision vectors
      state.collisionVector.add(this.response.overlapV);
    }

    // aInB and bInA is kept in state for later restore
    state.aInB = state.aInB || this.response.aInB;
    state.bInA = state.bInA || this.response.bInA;

    // cleared response is at end recreated properly for concaves
    this.response.clear();

    return state.collides;
  }
}
