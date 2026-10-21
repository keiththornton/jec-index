<?php
namespace Tests\Service;

use App\Service\UserService;
use App\Repo\UserRepo;
use PHPUnit\Framework\TestCase;

class UserServiceTest extends TestCase {
    public function testGetThrows(): void {
        $svc = new UserService(new UserRepo());
        $this->expectException(\App\Exceptions\NotFound::class);
        $svc->get(1);
    }
}
